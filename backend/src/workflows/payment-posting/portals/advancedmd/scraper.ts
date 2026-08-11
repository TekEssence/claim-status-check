import fs from "node:fs/promises";
import path from "node:path";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import type { Locator, Page } from "playwright-core";
import type { AutomationContext } from "../../../types";
import {
  buildPaymentPostingScreenshotFilename,
  createBaseResultRow,
  createPaymentPostingRunFolders,
  downloadableFileEvent,
  BasePaymentPostingRunner,
} from "../../base";
import type { PaymentPostingResultRow, PaymentPostingRunInput } from "../../types";
import { createStoredZipFromFolder } from "../../../payment-eob-download/portals/availity-remittance/zip";
import { advancedMdPaymentPostingConfig } from "./config";
import { readAdvancedMdCredentials } from "./credentials";
import { describeAdvancedMdInputHeaderMismatch, readAdvancedMdPaymentPostingInput } from "./input";
import { createPaymentPostingOutputWorkbookBuffer } from "./output-builder";
import {
  ADVANCEDMD_PAYMENT_POSTING_SELECTORS,
  AdvancedMdMissingSelectorError,
  AdvancedMdPatientMultipleMatchesError,
  AdvancedMdPatientNotFoundError,
  AdvancedMdPatientNotSelectedError,
  AdvancedMdPaymentEntryReadinessTimeoutError,
  AdvancedMdScreenshotError,
  AdvancedMdStatusNotFoundError,
  AdvancedMdVisitClaimNotFoundError,
  captureAdvancedMdPaymentPostingScreenshot,
  dismissAdvancedMdNotifications,
  loginToAdvancedMd,
  openAdvancedMdQuickPay,
  prepareAdvancedMdPaymentPostingRow,
  resolveAdvancedMdAppPage,
  waitForAdvancedMdPaymentEntryReady,
  type AdvancedMdPaymentEntryReadinessTiming,
  type AdvancedMdPreparedPaymentResult,
} from "./portal";

type PaymentEntryHealthCheckResult = {
  state: "healthy" | "broken";
  reasons: string[];
  appErrorText?: string;
  details: {
    paymentIframe: boolean;
    paymentEntryDom: boolean;
    eobCheckFound: boolean;
    eobCheckVisible: boolean;
    eobCheckEnabled: boolean;
    blockingDialog: boolean;
    paymentReasonsPopupOpen: boolean;
    blockingOverlay: boolean;
    genericOverlayVisible: boolean;
    visitClaimOverlayVisible: boolean;
    paymentReasonsSpecificEvidence: boolean;
    dashboardVisible: boolean;
    applicationError: boolean;
  };
};

type PaymentReasonsPopupHealthState = {
  popupVisible: boolean;
  blockingOverlayVisible: boolean;
  genericOverlayVisible: boolean;
  visitClaimOverlayVisible: boolean;
  paymentReasonsSpecificEvidence: boolean;
};

const PAYMENT_ENTRY_IFRAME_SELECTOR = "#frmPaymentEntry";
const UNSAVED_CHANGES_YES_SELECTOR = "[data-pendo-id=\"confirm-dialog-yes-button-20240229\"]";
const BLOCKING_CDK_BACKDROP_SELECTOR = [
  ".cdk-overlay-backdrop.cdk-overlay-backdrop-showing",
  ".cdk-overlay-backdrop.cdk-overlay-dark-backdrop.cdk-overlay-backdrop-showing",
].join(", ");

class AdvancedMdPaymentPostingRunner extends BasePaymentPostingRunner {
  readonly portalId = advancedMdPaymentPostingConfig.id;
  readonly name = `${advancedMdPaymentPostingConfig.name} Payment Posting`;

  async run(input: PaymentPostingRunInput, context: AutomationContext): Promise<void> {
    const folders = createPaymentPostingRunFolders(context.jobId);
    await Promise.all([
      fs.mkdir(folders.input, { recursive: true }),
      fs.mkdir(folders.logs, { recursive: true }),
      fs.mkdir(folders.screenshots, { recursive: true }),
    ]);

    await Promise.all([
      saveUploadedFile(input.credentialExcel, path.join(folders.input, input.credentialExcel.name || "credentials.xlsx")),
      saveUploadedFile(input.inputExcel, path.join(folders.input, input.inputExcel.name || "payment-posting-input.xlsx")),
    ]);

    const credentials = await readAdvancedMdCredentials(input.credentialExcel);
    const rows = await readAdvancedMdPaymentPostingInput(input.inputExcel);
    const results: PaymentPostingResultRow[] = [];
    await context.emit({ type: "progress", completed: 0, total: rows.length });

    // Validate every row up front, before touching the browser at all. This
    // used to be checked only inside the per-row loop, after login and
    // Quick Pay navigation had already run — so a fully-invalid workbook
    // still paid the cost of a full login cycle before reporting anything.
    const invalidRows = rows.filter((row) => row.validationErrors.length > 0);
    const validRows = rows.filter((row) => row.validationErrors.length === 0);

    for (const row of invalidRows) {
      const startedAt = new Date().toISOString();
      await context.log({
        level: "warn",
        message: `Row ${row.inputRow} failed validation and will be SKIPPED — no fields will be filled for this row. Reasons: ${row.validationErrors.join(" ")} ${describeAdvancedMdInputHeaderMismatch(row.raw)}`,
        eventName: "payment_posting_row_validation_failed",
      });
      results.push(validationFailedRow(context, row, startedAt, { filename: "", path: "", status: "" }));
      await context.emit({ type: "progress", completed: results.length, total: rows.length });
    }

    if (validRows.length === 0) {
      await context.log({
        level: "warn",
        message: rows.length > 0
          ? `All ${rows.length} row(s) failed validation. Fix the input workbook's column headers/values against the expected headers above and re-upload — no AdvancedMD browser automation was attempted.`
          : "The Payment Posting input workbook contained no rows to process.",
        eventName: "payment_posting_all_rows_validation_failed",
      });
    } else {
      await context.log({
        level: "info",
        message: `Payment Posting dry run loaded credentials for ${credentials.username}. ${validRows.length} of ${rows.length} input row(s) passed validation. Starting AdvancedMD browser automation.`,
        eventName: "payment_posting_validation_complete",
      });
      await runPortalRows(context, folders.screenshots, credentials, validRows, results, rows.length);
    }

    const workbookBuffer = await createPaymentPostingOutputWorkbookBuffer(results);
    await fs.writeFile(folders.outputWorkbook, workbookBuffer);
    await context.emit(downloadableFileEvent("PaymentPosting_Output.xlsx", workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));

    const zipBuffer = await createStoredZipFromFolder(folders.root, path.basename(folders.root));
    const zipFilename = `${path.basename(folders.root)}.zip`;
    await context.emit(downloadableFileEvent(zipFilename, zipBuffer, "application/zip"));
    await context.log({
      level: "info",
      message: `Payment Posting dry run completed without posting payments. Output folder: ${folders.root}`,
      eventName: "payment_posting_completed",
    });
  }
}

export function createAdvancedMdPaymentPostingRunner() {
  return new AdvancedMdPaymentPostingRunner();
}

async function runPortalRows(
  context: AutomationContext,
  screenshotFolder: string,
  credentials: Awaited<ReturnType<typeof readAdvancedMdCredentials>>,
  rows: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>,
  results: PaymentPostingResultRow[],
  progressTotal: number = rows.length,
): Promise<void> {
  const completedOffset = results.length;
  const session = await launchAutomationBrowser();
  let page = session.context.pages()[0] ?? await session.context.newPage();
  try {
    try {
      await context.log({ level: "info", message: "AdvancedMD login starting.", eventName: "payment_posting_advancedmd_login_start" });
      await loginToAdvancedMd(page, credentials, ADVANCEDMD_PAYMENT_POSTING_SELECTORS);
      await context.log({ level: "info", message: "AdvancedMD login submitted; checking notifications.", eventName: "payment_posting_advancedmd_login_submitted" });
      await dismissAdvancedMdNotifications(page, ADVANCEDMD_PAYMENT_POSTING_SELECTORS);
      await context.log({ level: "info", message: "AdvancedMD notifications handled; resolving app page.", eventName: "payment_posting_advancedmd_notifications_done" });
      page = await resolveAdvancedMdAppPage(page);
      await context.log({ level: "info", message: `AdvancedMD app page resolved: ${page.url()}`, eventName: "payment_posting_advancedmd_app_resolved" });
      const quickPayClickedAt = await openAdvancedMdQuickPay(page, ADVANCEDMD_PAYMENT_POSTING_SELECTORS);
      await context.log({
        level: "info",
        message: `AdvancedMD Quick Pay clicked at ${quickPayClickedAt.toISOString()}; waiting for EOB Check # readiness.`,
        eventName: "payment_posting_advancedmd_quickpay_clicked",
      });
      // Explicit checkpoint: confirm the Payment Entry screen actually rendered
      // before we start looping over rows and touching fields.
      const readinessTiming = await waitForAdvancedMdPaymentEntryReady(page, ADVANCEDMD_PAYMENT_POSTING_SELECTORS, undefined, {
        quickPayClickedAt,
        onTiming: async (label, timing) => {
          await logPaymentEntryReadinessTiming(context, label, timing);
        },
      });
      await context.log({
        level: "info",
        message: `AdvancedMD Payment Entry EOB Check # is interactable; starting row processing. Total load duration ${readinessTiming.totalLoadDurationMs} ms.`,
        eventName: "payment_posting_advancedmd_payment_entry_ready",
        meta: readinessTiming,
      });
    } catch (error) {
      if (error instanceof AdvancedMdPaymentEntryReadinessTimeoutError) {
        await logPaymentEntryReadinessTimeout(context, page, screenshotFolder, error);
      }
      await context.log({
        level: "error",
        message: `AdvancedMD setup failed before row processing. ${error instanceof Error ? error.message : String(error)}`,
        eventName: "payment_posting_advancedmd_setup_failed",
      });
      for (let index = 0; index < rows.length; index += 1) {
        const row = rows[index];
        const startedAt = new Date().toISOString();
        results.push(await automationFailedRow(context, page, screenshotFolder, row, error, startedAt));
        await context.emit({ type: "progress", completed: completedOffset + index + 1, total: progressTotal });
      }
      return;
    }

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const startedAt = new Date().toISOString();
      if (context.isCancelled?.()) {
        results.push(createBaseResultRow({
          input: row,
          portal: advancedMdPaymentPostingConfig.name,
          jobId: context.jobId,
          result: "Cancelled",
          botMessage: "Payment Posting run cancelled before this row was processed.",
          startedAt,
        }));
        await context.emit({ type: "progress", completed: completedOffset + index, total: progressTotal });
        await context.emit({ type: "cancelled", message: "Payment Posting dry run cancelled." });
        break;
      }

      if (row.validationErrors.length > 0) {
        await context.log({
          level: "warn",
          message: `Row ${row.inputRow} failed validation and will be SKIPPED — no fields will be filled for this row. Reasons: ${row.validationErrors.join(" ")} ${describeAdvancedMdInputHeaderMismatch(row.raw)}`,
          eventName: "payment_posting_row_validation_failed",
        });
        const validationScreenshot = await captureAutomationErrorScreenshot(page, screenshotFolder, row);
        results.push(validationFailedRow(context, row, startedAt, validationScreenshot));
      } else {
        let recoveryAttempts = 0;
        let rowCompleted = false;
        while (!rowCompleted) {
          const preRowHealth = await runAndLogPaymentEntryHealthCheck(context, page, row.inputRow);
          if (preRowHealth.state === "broken") {
            if (recoveryAttempts >= 1) {
              results.push(await automationFailedRow(context, page, screenshotFolder, row, new Error(`Payment Entry health check failed before row start: ${preRowHealth.reasons.join("; ")}`), startedAt));
              rowCompleted = true;
              break;
            }
            recoveryAttempts += 1;
            await recoverAdvancedMdPaymentEntry(context, page, screenshotFolder, row.inputRow, preRowHealth, recoveryAttempts);
          }

          let carcRarcAttempted = false;
          try {
            await context.log({
              level: "info",
              message: recoveryAttempts > 0
                ? `AdvancedMD row ${row.inputRow}: Retrying row after recovery attempt ${recoveryAttempts}.`
                : `AdvancedMD row ${row.inputRow}: starting field fill sequence.`,
              eventName: recoveryAttempts > 0 ? "payment_posting_advancedmd_row_retry_after_recovery" : "payment_posting_advancedmd_row_start",
              rowIndex: row.inputRow,
              meta: recoveryAttempts > 0 ? { recoveryAttempts } : undefined,
            });
            const prepared = await prepareAdvancedMdPaymentPostingRow({
              page,
              credentials,
              row,
              selectors: ADVANCEDMD_PAYMENT_POSTING_SELECTORS,
              screenshotFolder,
              fieldLogger: async (event) => {
                if (isCarcRarcAttemptEvent(event.eventName, event.meta)) {
                  carcRarcAttempted = true;
                }
                await context.log({
                  level: event.level ?? "info",
                  message: event.message,
                  eventName: event.eventName,
                  rowIndex: row.inputRow,
                  meta: event.meta,
                });
              },
            });
            results.push(filledNotPostedRow(context, row, prepared, startedAt));
            await context.log({
              level: "info",
              message: `AdvancedMD row ${row.inputRow}: Filled successfully - screenshot captured - not submitted.`,
              eventName: "payment_posting_advancedmd_row_filled_not_posted",
              rowIndex: row.inputRow,
            });
            await resetAdvancedMdPaymentEntry(page);
            rowCompleted = true;
          } catch (error) {
            await context.log({
              level: "error",
              message: `AdvancedMD row ${row.inputRow}: automation failed during Payment Entry field processing. ${error instanceof Error ? error.message : String(error)}`,
              eventName: "payment_posting_advancedmd_row_failed",
              rowIndex: row.inputRow,
            });
            const failureStage = failureStageForError(error, carcRarcAttempted);
            await logFailureRoutingDiagnostics(context, page, row.inputRow, failureStage, carcRarcAttempted);
            if (error instanceof AdvancedMdVisitClaimNotFoundError) {
              results.push(await handleVisitClaimNotFoundRowFailure(context, page, screenshotFolder, row, error, startedAt, recoveryAttempts));
              rowCompleted = true;
              continue;
            }
            if (error instanceof AdvancedMdPatientMultipleMatchesError) {
              results.push(await handlePatientMultipleMatchesRowFailure(context, page, screenshotFolder, row, error, startedAt, recoveryAttempts));
              rowCompleted = true;
              continue;
            }
            const postFailureHealth = await runAndLogPaymentEntryHealthCheck(context, page, row.inputRow);
            const paymentReasonsBrokenState = isPaymentReasonsBrokenState(carcRarcAttempted, postFailureHealth);
            if (paymentReasonsBrokenState && recoveryAttempts < 1) {
              await context.log({
                level: "warn",
                message: "CARC/RARC was reached. Payment Reasons-specific broken state detected. Starting Payment Reasons recovery.",
                eventName: "payment_posting_advancedmd_payment_reasons_recovery_starting",
                rowIndex: row.inputRow,
                meta: { carcRarcAttempted, health: postFailureHealth },
              });
              recoveryAttempts += 1;
              await recoverAdvancedMdPaymentEntry(context, page, screenshotFolder, row.inputRow, postFailureHealth, recoveryAttempts);
              continue;
            }
            if (postFailureHealth.state === "broken" && recoveryAttempts < 1) {
              recoveryAttempts += 1;
              await recoverAdvancedMdPaymentEntry(context, page, screenshotFolder, row.inputRow, postFailureHealth, recoveryAttempts);
              continue;
            }
            if (postFailureHealth.state === "healthy") {
              await context.log({
                level: "info",
                message: `AdvancedMD row ${row.inputRow}: Payment Entry health state is HEALTHY after failure. Continuing without recovery.`,
                eventName: "payment_posting_advancedmd_health_continue_without_recovery",
                rowIndex: row.inputRow,
              });
            }
            results.push(await automationFailedRow(context, page, screenshotFolder, row, error, startedAt));
            rowCompleted = true;
          }
        }
      }

      await context.emit({ type: "progress", completed: completedOffset + index + 1, total: progressTotal });
    }
  } finally {
    await session.browser?.close().catch(() => {});
  }
}

async function resetAdvancedMdPaymentEntry(page: Awaited<ReturnType<typeof resolveAdvancedMdAppPage>>): Promise<void> {
  const clearButton = page.locator("button:has-text(\"Clear\"), .clear-button, [data-pendo-id*=\"clear\" i]").first();
  if (await clearButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await clearButton.click().catch(() => {});
  }
}

async function runAndLogPaymentEntryHealthCheck(
  context: AutomationContext,
  page: Page,
  inputRow: number,
): Promise<PaymentEntryHealthCheckResult> {
  await context.log({
    level: "info",
    message: `AdvancedMD row ${inputRow}: Running Payment Entry health check.`,
    eventName: "payment_posting_advancedmd_health_check_start",
    rowIndex: inputRow,
  });
  const health = await checkPaymentEntryHealth(page);
  await context.log({
    level: health.state === "healthy" ? "info" : "warn",
    message: [
      `AdvancedMD row ${inputRow}: Payment iframe: ${yesNo(health.details.paymentIframe)}`,
      `Payment Entry DOM: ${yesNo(health.details.paymentEntryDom)}`,
      `EOB Check # found: ${yesNo(health.details.eobCheckFound)}`,
      `EOB Check # visible: ${yesNo(health.details.eobCheckVisible)}`,
      `EOB Check # enabled: ${yesNo(health.details.eobCheckEnabled)}`,
      `Blocking dialog: ${yesNo(health.details.blockingDialog)}`,
      `Payment Reasons popup open: ${yesNo(health.details.paymentReasonsPopupOpen)}`,
      `Blocking CDK overlay visible: ${yesNo(health.details.blockingOverlay)}`,
      `Generic CDK overlay visible: ${yesNo(health.details.genericOverlayVisible)}`,
      `Visit/Claim overlay visible: ${yesNo(health.details.visitClaimOverlayVisible)}`,
      `Payment Reasons-specific evidence: ${yesNo(health.details.paymentReasonsSpecificEvidence)}`,
      `AdvancedMD application error: ${yesNo(health.details.applicationError)}`,
      health.appErrorText ? `Application error: ${health.appErrorText}` : "",
      `Payment Entry health state: ${health.state.toUpperCase()}.`,
    ].filter(Boolean).join(" "),
    eventName: "payment_posting_advancedmd_health_check_result",
    rowIndex: inputRow,
    meta: health,
  });
  if (health.state === "healthy") {
    await context.log({
      level: "info",
      message: "Payment Entry health state: HEALTHY. Continuing without recovery.",
      eventName: "payment_posting_advancedmd_health_healthy_continue",
      rowIndex: inputRow,
    });
  }
  return health;
}

async function checkPaymentEntryHealth(page: Page): Promise<PaymentEntryHealthCheckResult> {
  const reasons: string[] = [];
  const iframe = page.locator(PAYMENT_ENTRY_IFRAME_SELECTOR).first();
  const paymentIframe = await iframe.count().then((count) => count > 0).catch(() => false);
  const frame = page.frameLocator(PAYMENT_ENTRY_IFRAME_SELECTOR);
  const checkNumberControl = frame.locator("[data-pendo-id=\"eob-checknumber-single-search-input-20250104\"]").first();
  const checkNumberInput = checkNumberControl.locator("input").first();
  const eobCheckFound = paymentIframe && await checkNumberInput.count().then((count) => count > 0).catch(() => false);
  const eobCheckVisible = eobCheckFound && await checkNumberInput.isVisible({ timeout: 500 }).catch(() => false);
  const eobCheckEnabled = eobCheckVisible && await checkNumberInput.isEnabled({ timeout: 500 }).catch(() => false);
  const paymentEntryDom = eobCheckFound;
  const blockingDialogSelector = [
    ".mat-dialog-container",
    ".cdk-overlay-pane",
    "[role=\"dialog\"]",
  ].join(", ");
  const iframeBlockingDialogText = await visibleText(frame.locator(blockingDialogSelector).filter({ hasText: /unsaved changes|warning|are you sure/i }).first());
  const pageBlockingDialogText = await visibleText(page.locator(blockingDialogSelector).filter({ hasText: /unsaved changes|warning|are you sure/i }).first());
  const blockingDialogText = iframeBlockingDialogText || pageBlockingDialogText;
  const reasonsPopup = await paymentReasonsPopupHealthState(page);
  const appErrorText = await detectAdvancedMdApplicationError(page);
  const dashboardVisible = await page.locator("text=FINANCIAL HEALTH").first().isVisible({ timeout: 500 }).catch(() => false);

  if (!paymentIframe) reasons.push("Payment iframe missing");
  if (!paymentEntryDom) reasons.push("Payment Entry DOM missing");
  if (!eobCheckFound) reasons.push("EOB Check # control missing");
  if (eobCheckFound && !eobCheckVisible) reasons.push("EOB Check # not visible");
  if (eobCheckVisible && !eobCheckEnabled) reasons.push("EOB Check # not interactable");
  if (blockingDialogText) reasons.push(`Blocking dialog visible: ${blockingDialogText}`);
  if (reasonsPopup.popupVisible) reasons.push("Payment Reasons / Remark Codes popup left open");
  if (reasonsPopup.paymentReasonsSpecificEvidence && reasonsPopup.blockingOverlayVisible) reasons.push("Payment Reasons-specific blocking state visible");
  if (!reasonsPopup.paymentReasonsSpecificEvidence && reasonsPopup.genericOverlayVisible) reasons.push("Generic CDK blocking overlay visible");
  if (dashboardVisible && !paymentEntryDom) reasons.push("Payment Entry replaced by Dashboard");
  if (appErrorText) reasons.push(`AdvancedMD application error detected: ${appErrorText}`);

  return {
    state: reasons.length > 0 ? "broken" : "healthy",
    reasons,
    appErrorText,
    details: {
      paymentIframe,
      paymentEntryDom,
      eobCheckFound,
      eobCheckVisible,
      eobCheckEnabled,
      blockingDialog: !!blockingDialogText,
      paymentReasonsPopupOpen: reasonsPopup.popupVisible,
      blockingOverlay: reasonsPopup.blockingOverlayVisible,
      genericOverlayVisible: reasonsPopup.genericOverlayVisible,
      visitClaimOverlayVisible: reasonsPopup.visitClaimOverlayVisible,
      paymentReasonsSpecificEvidence: reasonsPopup.paymentReasonsSpecificEvidence,
      dashboardVisible,
      applicationError: !!appErrorText,
    },
  };
}

async function recoverAdvancedMdPaymentEntry(
  context: AutomationContext,
  page: Page,
  screenshotFolder: string,
  inputRow: number,
  health: PaymentEntryHealthCheckResult,
  recoveryAttempt: number,
): Promise<void> {
  await context.log({
    level: "warn",
    message: `AdvancedMD row ${inputRow}: Starting recovery. Reasons: ${health.reasons.join("; ") || "unknown"}`,
    eventName: "payment_posting_advancedmd_recovery_start",
    rowIndex: inputRow,
    meta: { recoveryAttempt, health },
  });
  const recoveryScreenshot = await captureRecoveryScreenshot(page, screenshotFolder, inputRow, recoveryAttempt);
  await context.log({
    level: "warn",
    message: `Recovery screenshot captured: ${recoveryScreenshot.path}`,
    eventName: "payment_posting_advancedmd_recovery_screenshot",
    rowIndex: inputRow,
    meta: recoveryScreenshot,
  });

  if (health.details.paymentReasonsSpecificEvidence) {
    await closePaymentReasonsOverlayIfPresent(context, page, inputRow);
  }

  const frame = page.frameLocator(PAYMENT_ENTRY_IFRAME_SELECTOR);
  const cancelButton = frame
    .locator("[data-pendo-id=\"payment-entry-cancel-close-card-capture-button-20240229\"]")
    .first();
  if (await cancelButton.isVisible({ timeout: 10000 }).catch(() => false)) {
    await cancelButton.click();
    await context.log({ level: "info", message: "Payment Entry Cancel clicked", eventName: "payment_posting_advancedmd_recovery_cancel_clicked", rowIndex: inputRow });
  } else {
    await context.log({ level: "warn", message: "Payment Entry Cancel button was not visible during recovery; continuing to main-screen readiness check.", eventName: "payment_posting_advancedmd_recovery_cancel_not_visible", rowIndex: inputRow });
  }

  const iframeYesButton = frame.locator(UNSAVED_CHANGES_YES_SELECTOR).first();
  const pageYesButton = page.locator(UNSAVED_CHANGES_YES_SELECTOR).first();
  const iframeYesVisible = await iframeYesButton.isVisible({ timeout: 5000 }).catch(() => false);
  const yesButton = iframeYesVisible ? iframeYesButton : pageYesButton;
  if (await yesButton.isVisible({ timeout: 5000 }).catch(() => false)) {
    await context.log({
      level: "info",
      message: iframeYesVisible
        ? "Unsaved changes confirmation detected in Payment Entry iframe"
        : "Unsaved changes confirmation detected in page fallback",
      eventName: "payment_posting_advancedmd_recovery_unsaved_warning",
      rowIndex: inputRow,
    });
    await yesButton.click();
    await context.log({ level: "info", message: "Discard changes Yes clicked", eventName: "payment_posting_advancedmd_recovery_yes_clicked", rowIndex: inputRow });
    await yesButton.waitFor({ state: "hidden", timeout: 10000 }).catch(async () => {
      await yesButton.waitFor({ state: "detached", timeout: 1000 });
    });
    await context.log({ level: "info", message: "Unsaved changes confirmation cleared", eventName: "payment_posting_advancedmd_recovery_unsaved_cleared", rowIndex: inputRow });
  }

  await waitForBlockingBackdropsToClear(page, "iframe", 10000);
  await context.log({ level: "info", message: "Iframe blocking backdrop cleared", eventName: "payment_posting_advancedmd_recovery_iframe_backdrop_cleared", rowIndex: inputRow });
  await waitForBlockingBackdropsToClear(page, "page", 10000);
  await context.log({ level: "info", message: "Outer-page blocking backdrop cleared", eventName: "payment_posting_advancedmd_recovery_page_backdrop_cleared", rowIndex: inputRow });

  await waitForOldPaymentEntryToExit(page, 60000);
  await page.locator("a.dropdown-toggle[ng-bind=\"menuItem.title\"]").filter({ hasText: "Billing" }).first().waitFor({ state: "visible", timeout: 60000 });
  await context.log({ level: "info", message: "Dashboard reached", eventName: "payment_posting_advancedmd_recovery_dashboard_reached", rowIndex: inputRow });
  await context.log({ level: "info", message: "Opening Billing -> Quick Pay", eventName: "payment_posting_advancedmd_recovery_opening_quickpay", rowIndex: inputRow });
  const quickPayClickedAt = await openAdvancedMdQuickPay(page, ADVANCEDMD_PAYMENT_POSTING_SELECTORS);
  await waitForAdvancedMdPaymentEntryReady(page, ADVANCEDMD_PAYMENT_POSTING_SELECTORS, undefined, {
    quickPayClickedAt,
    onTiming: async (label, timing) => {
      await logPaymentEntryReadinessTiming(context, label, timing);
    },
  });
  await context.log({ level: "info", message: "Fresh Payment Entry ready", eventName: "payment_posting_advancedmd_recovery_fresh_ready", rowIndex: inputRow });
  const freshHealth = await checkPaymentEntryHealth(page);
  await context.log({
    level: freshHealth.state === "healthy" ? "info" : "warn",
    message: `Fresh Payment Entry health state: ${freshHealth.state.toUpperCase()}`,
    eventName: "payment_posting_advancedmd_recovery_fresh_health",
    rowIndex: inputRow,
    meta: freshHealth,
  });
  if (freshHealth.state !== "healthy") {
    throw new Error(`Fresh Payment Entry health check failed after recovery: ${freshHealth.reasons.join("; ") || "unknown"}`);
  }
  await context.log({
    level: "info",
    message: "Retrying same row",
    eventName: "payment_posting_advancedmd_recovery_ready_retrying",
    rowIndex: inputRow,
    meta: { recoveryAttempt },
  });
}

async function captureRecoveryScreenshot(page: Page, screenshotFolder: string, inputRow: number, recoveryAttempt: number): Promise<{ filename: string; path: string; status: string }> {
  const filename = `advancedmd_row_${inputRow}_recovery_attempt_${recoveryAttempt}_${Date.now()}.png`;
  const screenshotPath = path.join(screenshotFolder, filename);
  try {
    await captureAdvancedMdPaymentPostingScreenshot(page, filename, screenshotPath);
    return { filename, path: screenshotPath, status: "Captured" };
  } catch {
    return { filename, path: screenshotPath, status: "Failed" };
  }
}

async function handleVisitClaimNotFoundRowFailure(
  context: AutomationContext,
  page: Page,
  screenshotFolder: string,
  row: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>[number],
  error: AdvancedMdVisitClaimNotFoundError,
  startedAt: string,
  recoveryAttempts: number,
): Promise<PaymentPostingResultRow> {
  await context.log({
    level: "warn",
    message: "Visit/Claim Not Found is a handled row outcome. CARC/RARC was not reached. Payment Reasons recovery skipped.",
    eventName: "payment_posting_advancedmd_visit_claim_not_found_handled",
    rowIndex: row.inputRow,
  });
  await dismissVisitClaimOverlayIfPresent(page);
  await context.log({
    level: "info",
    message: "Visit dropdown dismissed.",
    eventName: "payment_posting_advancedmd_visit_dropdown_dismissed",
    rowIndex: row.inputRow,
  });
  const cleanupHealth = await checkPaymentEntryHealth(page);
  await context.log({
    level: cleanupHealth.state === "healthy" ? "info" : "warn",
    message: `Payment Entry health after cleanup: ${cleanupHealth.state.toUpperCase()}.`,
    eventName: "payment_posting_advancedmd_visit_claim_cleanup_health",
    rowIndex: row.inputRow,
    meta: cleanupHealth,
  });
  if (cleanupHealth.state === "broken" && recoveryAttempts < 1) {
    await recoverAdvancedMdPaymentEntry(context, page, screenshotFolder, row.inputRow, cleanupHealth, recoveryAttempts + 1);
  }
  return automationFailedRow(context, page, screenshotFolder, row, error, startedAt);
}

async function handlePatientMultipleMatchesRowFailure(
  context: AutomationContext,
  page: Page,
  screenshotFolder: string,
  row: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>[number],
  error: AdvancedMdPatientMultipleMatchesError,
  startedAt: string,
  recoveryAttempts: number,
): Promise<PaymentPostingResultRow> {
  await context.log({
    level: "warn",
    message: `${error.matchCount} Matches found. Patient selection skipped; no dropdown option selected.`,
    eventName: "payment_posting_advancedmd_patient_multiple_matches_handled",
    rowIndex: row.inputRow,
    meta: { matchCount: error.matchCount, matches: error.matches },
  });
  await dismissPatientOverlayIfPresent(page);
  await context.log({
    level: "info",
    message: "Patient dropdown dismissed.",
    eventName: "payment_posting_advancedmd_patient_dropdown_dismissed",
    rowIndex: row.inputRow,
  });
  const cleanupHealth = await checkPaymentEntryHealth(page);
  await context.log({
    level: cleanupHealth.state === "healthy" ? "info" : "warn",
    message: `Payment Entry health after patient-match cleanup: ${cleanupHealth.state.toUpperCase()}.`,
    eventName: "payment_posting_advancedmd_patient_multiple_matches_cleanup_health",
    rowIndex: row.inputRow,
    meta: cleanupHealth,
  });
  if (cleanupHealth.state === "broken" && recoveryAttempts < 1) {
    await recoverAdvancedMdPaymentEntry(context, page, screenshotFolder, row.inputRow, cleanupHealth, recoveryAttempts + 1);
  }
  return automationFailedRow(context, page, screenshotFolder, row, error, startedAt);
}

async function closePaymentReasonsOverlayIfPresent(context: AutomationContext, page: Page, inputRow: number): Promise<void> {
  const frame = page.frameLocator(PAYMENT_ENTRY_IFRAME_SELECTOR);
  const state = await paymentReasonsPopupHealthState(page);
  if (!state.paymentReasonsSpecificEvidence) return;
  const iframePopupCancel = frame.locator("[data-pendo-id=\"close-panel-reasons-20240229\"]").first();
  const pagePopupCancel = page.locator("[data-pendo-id=\"close-panel-reasons-20240229\"]").first();
  const popupCancel = await iframePopupCancel.isVisible({ timeout: 1000 }).catch(() => false)
    ? iframePopupCancel
    : pagePopupCancel;
  const popupCancelExists = await popupCancel.count().then((count) => count > 0).catch(() => false);
  const popupCancelVisible = await popupCancel.isVisible({ timeout: 1000 }).catch(() => false);
  const backdropVisible = state.blockingOverlayVisible;
  if (!popupCancelExists && !popupCancelVisible && !backdropVisible) return;

  await context.log({
    level: "warn",
    message: `AdvancedMD row ${inputRow}: Payment Reasons overlay detected.`,
    eventName: "payment_posting_advancedmd_recovery_reasons_overlay_detected",
    rowIndex: inputRow,
    meta: { popupCancelExists, popupCancelVisible, backdropVisible },
  });

  if (popupCancelVisible) {
    await popupCancel.click({ timeout: 5000 });
    await context.log({ level: "info", message: "Payment Reasons popup Cancel clicked", eventName: "payment_posting_advancedmd_recovery_reasons_cancel_clicked", rowIndex: inputRow });
  } else if (popupCancelExists || backdropVisible) {
    throw new Error("Payment Reasons popup/backdrop detected, but Cancel was not visibly clickable.");
  }

  await waitForPaymentReasonsBackdropToClear(page, 5000);
  await context.log({
    level: "info",
    message: "Payment Reasons popup cleared",
    eventName: "payment_posting_advancedmd_recovery_reasons_overlay_cleared",
    rowIndex: inputRow,
  });
}

async function waitForPaymentReasonsBackdropToClear(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const reasonsPopup = await paymentReasonsPopupHealthState(page);
    if (!reasonsPopup.popupVisible && !reasonsPopup.genericOverlayVisible) return;
    await page.waitForTimeout(100);
  }
  throw new Error("Payment Reasons popup/backdrop did not clear.");
}

async function paymentReasonsPopupHealthState(page: Page): Promise<PaymentReasonsPopupHealthState> {
  const frame = page.frameLocator(PAYMENT_ENTRY_IFRAME_SELECTOR);
  const paymentReasonsTabVisible = await isVisibleInFrameOrPage(frame.locator("a[mat-tab-link]").filter({ hasText: /^Payment Reasons$/ }).first(), page.locator("a[mat-tab-link]").filter({ hasText: /^Payment Reasons$/ }).first());
  const remarkCodesTabVisible = await isVisibleInFrameOrPage(frame.locator("a[mat-tab-link]").filter({ hasText: /^Remark Codes$/ }).first(), page.locator("a[mat-tab-link]").filter({ hasText: /^Remark Codes$/ }).first());
  const saveButtonVisible = await isVisibleInFrameOrPage(frame.locator("[data-pendo-id=\"save-panel-reasons-20240229\"]").first(), page.locator("[data-pendo-id=\"save-panel-reasons-20240229\"]").first());
  const cancelButtonVisible = await isVisibleInFrameOrPage(frame.locator("[data-pendo-id=\"close-panel-reasons-20240229\"]").first(), page.locator("[data-pendo-id=\"close-panel-reasons-20240229\"]").first());
  const genericOverlayVisible = await hasVisibleBlockingBackdrop(page);
  const visitClaimOverlayIsVisible = await visitClaimOverlayVisible(page);
  const paymentReasonsSpecificEvidence = paymentReasonsTabVisible || remarkCodesTabVisible || saveButtonVisible || cancelButtonVisible;
  return {
    popupVisible: (paymentReasonsTabVisible || remarkCodesTabVisible) && (saveButtonVisible || cancelButtonVisible),
    blockingOverlayVisible: genericOverlayVisible,
    genericOverlayVisible,
    visitClaimOverlayVisible: visitClaimOverlayIsVisible,
    paymentReasonsSpecificEvidence,
  };
}

async function logFailureRoutingDiagnostics(
  context: AutomationContext,
  page: Page,
  inputRow: number,
  failureStage: "Visit/Claim" | "CARC-RARC" | "Other",
  carcRarcAttempted: boolean,
): Promise<void> {
  const overlayState = await paymentReasonsPopupHealthState(page);
  await context.log({
    level: "info",
    message: [
      `Failure stage: ${failureStage}`,
      `Generic CDK overlay visible: ${yesNo(overlayState.genericOverlayVisible)}`,
      `Visit/Claim overlay visible: ${yesNo(overlayState.visitClaimOverlayVisible)}`,
      `Payment Reasons-specific evidence: ${yesNo(overlayState.paymentReasonsSpecificEvidence)}`,
      `CARC/RARC attempted for this row: ${yesNo(carcRarcAttempted)}`,
    ].join(". "),
    eventName: "payment_posting_advancedmd_failure_routing_diagnostics",
    rowIndex: inputRow,
    meta: { failureStage, carcRarcAttempted, overlayState },
  });
}

async function dismissVisitClaimOverlayIfPresent(page: Page): Promise<void> {
  if (!await visitClaimOverlayVisible(page)) return;
  await page.keyboard.press("Escape").catch(() => {});
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!await visitClaimOverlayVisible(page)) return;
    await page.waitForTimeout(100);
  }
}

async function dismissPatientOverlayIfPresent(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(250);
}

async function visitClaimOverlayVisible(page: Page): Promise<boolean> {
  const frame = page.frameLocator(PAYMENT_ENTRY_IFRAME_SELECTOR);
  const visibleOptionText = await firstVisibleText([
    frame.locator(".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"], .cdk-overlay-pane [role=\"option\"]").first(),
    page.locator(".mat-autocomplete-panel [role=\"option\"], [role=\"listbox\"] [role=\"option\"], .cdk-overlay-pane [role=\"option\"]").first(),
  ]);
  return /\b(visit|claim|\d{1,2}\/\d{1,2}\/\d{2,4})\b/i.test(visibleOptionText);
}

async function firstVisibleText(locators: Locator[]): Promise<string> {
  for (const locator of locators) {
    const text = await visibleText(locator);
    if (text) return text;
  }
  return "";
}

function isPaymentReasonsBrokenState(carcRarcAttempted: boolean, health: PaymentEntryHealthCheckResult): boolean {
  return carcRarcAttempted && (health.details.paymentReasonsSpecificEvidence || !!health.appErrorText);
}

function isCarcRarcAttemptEvent(eventName: string | undefined, meta: unknown): boolean {
  if (eventName && /carc|rarc|remark_codes|reasons_popup/i.test(eventName)) return true;
  if (isRecord(meta) && typeof meta.field === "string" && /CARC\/RARC/i.test(meta.field)) return true;
  return false;
}

function failureStageForError(error: unknown, carcRarcAttempted: boolean): "Visit/Claim" | "CARC-RARC" | "Other" {
  if (error instanceof AdvancedMdVisitClaimNotFoundError) return "Visit/Claim";
  if (carcRarcAttempted) return "CARC-RARC";
  return "Other";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function hasVisibleBlockingBackdrop(page: Page): Promise<boolean> {
  return await visibleBlockingBackdrop(page.frameLocator(PAYMENT_ENTRY_IFRAME_SELECTOR).locator(BLOCKING_CDK_BACKDROP_SELECTOR).first())
    || await visibleBlockingBackdrop(page.locator(BLOCKING_CDK_BACKDROP_SELECTOR).first());
}

async function visibleBlockingBackdrop(locator: Locator): Promise<boolean> {
  return await locator.isVisible({ timeout: 250 }).catch(() => false);
}

async function isVisibleInFrameOrPage(iframeLocator: Locator, pageLocator: Locator): Promise<boolean> {
  return await iframeLocator.isVisible({ timeout: 250 }).catch(() => false)
    || await pageLocator.isVisible({ timeout: 250 }).catch(() => false);
}

async function waitForBlockingBackdropsToClear(page: Page, scope: "iframe" | "page", timeoutMs: number): Promise<void> {
  const locator = scope === "iframe"
    ? page.frameLocator(PAYMENT_ENTRY_IFRAME_SELECTOR).locator(BLOCKING_CDK_BACKDROP_SELECTOR).first()
    : page.locator(BLOCKING_CDK_BACKDROP_SELECTOR).first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!await visibleBlockingBackdrop(locator)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`${scope === "iframe" ? "Iframe" : "Outer-page"} blocking backdrop did not clear.`);
}

async function waitForOldPaymentEntryToExit(page: Page, timeoutMs: number): Promise<void> {
  const frame = page.frameLocator(PAYMENT_ENTRY_IFRAME_SELECTOR);
  const oldEobCheck = frame.locator("[data-pendo-id=\"eob-checknumber-single-search-input-20250104\"] input").first();
  const dashboard = page.locator("text=FINANCIAL HEALTH").first();
  const billingMenu = page.locator("a.dropdown-toggle[ng-bind=\"menuItem.title\"]").filter({ hasText: "Billing" }).first();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const oldPaymentEntryVisible = await oldEobCheck.isVisible({ timeout: 250 }).catch(() => false);
    const dashboardReady = await dashboard.isVisible({ timeout: 250 }).catch(() => false)
      || await billingMenu.isVisible({ timeout: 250 }).catch(() => false);
    if (!oldPaymentEntryVisible && dashboardReady) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Payment Entry did not exit to a Dashboard-ready state after recovery Cancel.");
}

async function detectAdvancedMdApplicationError(page: Page): Promise<string> {
  const candidates = page.locator([
    ".toast",
    ".toast-message",
    ".notification",
    ".alert",
    ".mat-snack-bar-container",
    ".cdk-overlay-pane",
    "[role=\"alert\"]",
    "body",
  ].join(", "));
  const count = Math.min(await candidates.count().catch(() => 0), 20);
  for (let index = 0; index < count; index += 1) {
    const text = await visibleText(candidates.nth(index));
    if (/\b(Cannot read properties of|TypeError|application error)\b/i.test(text) || /\bundefined\b/i.test(text)) return text;
  }
  return "";
}

async function visibleText(locator: Locator): Promise<string> {
  if (!await locator.isVisible({ timeout: 500 }).catch(() => false)) return "";
  return (await locator.textContent({ timeout: 500 }).catch(() => ""))?.replace(/\s+/g, " ").trim() ?? "";
}

function yesNo(value: boolean): "Yes" | "No" {
  return value ? "Yes" : "No";
}

async function logPaymentEntryReadinessTiming(
  context: AutomationContext,
  label: string,
  timing: AdvancedMdPaymentEntryReadinessTiming,
): Promise<void> {
  await context.log({
    level: "info",
    message: `AdvancedMD Payment Entry readiness: ${label} ${readinessTimestampForLabel(label, timing)}; total load duration ${timing.totalLoadDurationMs} ms.`,
    eventName: "payment_posting_advancedmd_payment_entry_readiness_timing",
    meta: timing,
  });
}

function readinessTimestampForLabel(label: string, timing: AdvancedMdPaymentEntryReadinessTiming): string {
  if (label.startsWith("Payment iframe")) return timing.paymentIframeDetectedAt ?? "not detected";
  if (label.startsWith("Payment Entry DOM")) return timing.paymentEntryDomDetectedAt ?? "not detected";
  if (label.startsWith("EOB Check # visible")) return timing.eobCheckVisibleAt ?? "not detected";
  if (label.startsWith("EOB Check # interactable")) return timing.eobCheckInteractableAt ?? "not detected";
  return timing.quickPayClickedAt ?? "not recorded";
}

async function logPaymentEntryReadinessTimeout(
  context: AutomationContext,
  page: Awaited<ReturnType<typeof resolveAdvancedMdAppPage>>,
  screenshotFolder: string,
  error: AdvancedMdPaymentEntryReadinessTimeoutError,
): Promise<void> {
  const filename = `advancedmd_payment_entry_readiness_timeout_${Date.now()}.png`;
  const screenshotPath = path.join(screenshotFolder, filename);
  let screenshotStatus = "captured";
  try {
    await captureAdvancedMdPaymentPostingScreenshot(page, filename, screenshotPath);
  } catch {
    screenshotStatus = "failed";
  }

  await context.log({
    level: "error",
    message: [
      "AdvancedMD Payment Entry readiness timeout.",
      `EOB Check # locator found=${error.locatorState.found}, visible=${error.locatorState.visible}, enabled=${error.locatorState.enabled}.`,
      `Readiness screenshot ${screenshotStatus}: ${screenshotPath}.`,
      `Total load duration ${error.timing.totalLoadDurationMs} ms.`,
    ].join(" "),
    eventName: "payment_posting_advancedmd_payment_entry_readiness_timeout",
    meta: {
      locatorState: error.locatorState,
      timing: error.timing,
      screenshotPath,
      screenshotStatus,
    },
  });
}

function validationFailedRow(
  context: AutomationContext,
  row: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>[number],
  startedAt: string,
  screenshot: { filename: string; path: string; status: string },
): PaymentPostingResultRow {
  return {
    ...createBaseResultRow({
      input: row,
      portal: advancedMdPaymentPostingConfig.name,
      jobId: context.jobId,
      result: "Validation Failed",
      botMessage: "Input row failed strict validation. No fields were filled for this row.",
      errorDetails: `${row.validationErrors.join(" ")} ${describeAdvancedMdInputHeaderMismatch(row.raw)}`,
      startedAt,
      screenshotFilename: screenshot.filename,
    }),
    screenshotPath: screenshot.path,
    screenshotStatus: screenshot.status,
  };
}

async function automationFailedRow(
  context: AutomationContext,
  page: Awaited<ReturnType<typeof resolveAdvancedMdAppPage>>,
  screenshotFolder: string,
  row: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>[number],
  error: unknown,
  startedAt: string,
): Promise<PaymentPostingResultRow> {
  const message = error instanceof Error ? error.message : String(error);
  const selectorDetails = error instanceof AdvancedMdMissingSelectorError
    ? `Missing or ambiguous selectors: ${error.missingSelectors.join(", ")}`
    : message;
  if (error instanceof AdvancedMdScreenshotError) {
    return {
      ...createBaseResultRow({
        input: row,
        portal: advancedMdPaymentPostingConfig.name,
        jobId: context.jobId,
        result: "Screenshot Failed",
        botMessage: "AdvancedMD row was filled, but screenshot capture failed. No payment was submitted.",
        errorDetails: message,
        startedAt,
        screenshotFilename: error.screenshotFilename,
      }),
      screenshotPath: error.screenshotPath,
      screenshotStatus: "Failed",
    };
  }
  const screenshot = await captureAutomationErrorScreenshot(page, screenshotFolder, row);
  const result = paymentPostingFailureResult(error);
  const botMessage = paymentPostingFailureBotMessage(error);
  const resultRow = {
    ...createBaseResultRow({
      input: row,
      portal: advancedMdPaymentPostingConfig.name,
      jobId: context.jobId,
      result,
      botMessage,
      errorDetails: selectorDetails,
      startedAt,
      screenshotFilename: screenshot.filename,
    }),
    screenshotPath: screenshot.path,
    screenshotStatus: screenshot.status,
  };
  if (error instanceof AdvancedMdVisitClaimNotFoundError && error.visitComparison) {
    Object.assign(resultRow, error.visitComparison);
  }
  if (error instanceof AdvancedMdStatusNotFoundError) {
    Object.assign(resultRow, error.statusDetails);
  }
  return resultRow;
}

function paymentPostingFailureResult(error: unknown): PaymentPostingResultRow["result"] {
  if (error instanceof AdvancedMdPatientMultipleMatchesError) return "Patient Not Found";
  if (error instanceof AdvancedMdPatientNotFoundError) return "Patient Not Found";
  if (error instanceof AdvancedMdPatientNotSelectedError) return "Patient Not Selected";
  if (error instanceof AdvancedMdVisitClaimNotFoundError) return "Visit/Claim Not Found";
  if (error instanceof AdvancedMdStatusNotFoundError) return "Automation Failed";
  return "Automation Failed";
}

function paymentPostingFailureBotMessage(error: unknown): string {
  if (error instanceof AdvancedMdPatientMultipleMatchesError) return `${error.matchCount} Matches found. No patient was selected and no payment was submitted.`;
  if (error instanceof AdvancedMdPatientNotFoundError) return "Patient Not Found. No payment was submitted.";
  if (error instanceof AdvancedMdPatientNotSelectedError) return "Patient Not Selected. No payment was submitted.";
  if (error instanceof AdvancedMdVisitClaimNotFoundError && error.message.includes("no visit options")) return "No Visit/Claim options were available for the selected patient.";
  if (error instanceof AdvancedMdVisitClaimNotFoundError) return "Visit/Claim Not Found. No payment was submitted.";
  if (error instanceof AdvancedMdStatusNotFoundError) return "Status Not Found. No payment was submitted.";
  return "AdvancedMD dry-run automation failed during Payment Entry field processing. No payment was submitted.";
}

async function captureAutomationErrorScreenshot(
  page: Awaited<ReturnType<typeof resolveAdvancedMdAppPage>>,
  screenshotFolder: string,
  row: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>[number],
): Promise<{ filename: string; path: string; status: string }> {
  const filename = buildPaymentPostingScreenshotFilename(row).replace(/\.png$/i, "_error.png");
  const screenshotPath = path.join(screenshotFolder, filename);
  try {
    await captureAdvancedMdPaymentPostingScreenshot(page, filename, screenshotPath);
    return {
      filename,
      path: screenshotPath,
      status: "Error Screenshot Captured",
    };
  } catch {
    return {
      filename,
      path: screenshotPath,
      status: "Failed",
    };
  }
}

function filledNotPostedRow(
  context: AutomationContext,
  row: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>[number],
  prepared: AdvancedMdPreparedPaymentResult,
  startedAt: string,
): PaymentPostingResultRow {
  return {
    ...createBaseResultRow({
      input: row,
      portal: advancedMdPaymentPostingConfig.name,
      jobId: context.jobId,
      result: "Filled - Not Posted",
      botMessage: "AdvancedMD row filled in dry-run mode. Posting was not attempted.",
      startedAt,
      screenshotFilename: prepared.screenshotFilename,
    }),
    checkNumberEntered: prepared.checkNumberEntered,
    carrierSelected: prepared.carrierSelected,
    checkAmountEntered: prepared.checkAmountEntered,
    depositDateEntered: prepared.depositDateEntered,
    patientSelected: prepared.patientSelected,
    patientIdSelected: prepared.patientIdSelected,
    visitClaimSelected: prepared.visitClaimSelected,
    visitDateSelected: prepared.visitDateSelected,
    visitTimeSelected: prepared.visitTimeSelected,
    visitDateCanonical: prepared.visitDateCanonical,
    dosInputRaw: prepared.dosInputRaw,
    dosInputShortFormat: prepared.dosInputShortFormat,
    dosInputFullFormat: prepared.dosInputFullFormat,
    dosInputCanonical: prepared.dosInputCanonical,
    visitInitialOptionCount: prepared.visitInitialOptionCount,
    visitRetryPerformed: prepared.visitRetryPerformed,
    visitFinalOptionCount: prepared.visitFinalOptionCount,
    visitOptionsFoundCount: prepared.visitOptionsFoundCount,
    visitOptionsFound: prepared.visitOptionsFound,
    visitComparisonDetails: prepared.visitComparisonDetails,
    dosMatch: prepared.dosMatch,
    visitMatchResult: prepared.visitMatchResult,
    paymentAmountEntered: prepared.paymentAmountEntered,
    lineItemCode: prepared.lineItemCode,
    cptMatch: "Yes",
    lineItemCharge: prepared.lineItemCharge,
    chargeMatch: "Yes",
    lineMatchResult: prepared.lineMatchResult,
    insurancePortion: prepared.insurancePortion,
    patientPortion: prepared.patientPortion,
    insuranceAllowedEntered: prepared.insuranceAllowedEntered,
    insuranceNotAllowed: prepared.insuranceNotAllowed,
    paymentEntered: prepared.paymentEntered,
    insuranceBalance: prepared.insuranceBalance,
    patientBalance: prepared.patientBalance,
    writeOffCode: prepared.writeOffCode,
    writeOffAmount: prepared.writeOffAmount,
    riskCode: prepared.riskCode,
    riskAmount: prepared.riskAmount,
    carcSelected: prepared.carcSelected,
    rarcSelected: prepared.rarcSelected,
    denialCodeSelected: prepared.denialCodeSelected,
    denialCodeDescription: prepared.denialCodeDescription,
    reasonDescriptionSelected: prepared.reasonDescriptionSelected,
    remarkCodePopupStatus: prepared.remarkCodePopupStatus,
    remarkCodeSaveStatus: prepared.remarkCodeSaveStatus,
    previousDisplayedStatus: prepared.previousDisplayedStatus,
    statusOptionsFound: prepared.statusOptionsFound,
    statusSelected: prepared.statusSelected,
    statusMatch: prepared.statusMatch,
    statusAction: prepared.statusAction,
    finalDisplayedStatus: prepared.finalDisplayedStatus,
    provider: prepared.provider,
    screenshotPath: prepared.screenshotPath,
    screenshotStatus: prepared.screenshotStatus,
    filledFields: [
      "EOB Check #",
      "EOB Carrier",
      "EOB Check Amount",
      "EOB Deposit Date",
      "Patient",
      "Visit/Claim #",
      "Payment Amount",
      "Line Item Payment",
      prepared.insuranceAllowedEntered ? "Insurance Allowed" : "",
      prepared.carcSelected || prepared.rarcSelected ? "CARC/RARC" : "",
      prepared.statusAction === "Updated" ? "Status" : "",
    ].filter(Boolean).join(", "),
    skippedFields: "Post action",
  };
}

async function saveUploadedFile(file: File, targetPath: string): Promise<void> {
  await fs.writeFile(targetPath, Buffer.from(await file.arrayBuffer()));
}
