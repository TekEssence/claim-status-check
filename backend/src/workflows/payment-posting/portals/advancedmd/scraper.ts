import fs from "node:fs/promises";
import path from "node:path";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
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
  AdvancedMdPatientNotFoundError,
  AdvancedMdPatientNotSelectedError,
  AdvancedMdPaymentEntryReadinessTimeoutError,
  AdvancedMdScreenshotError,
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
        try {
          await context.log({
            level: "info",
            message: `AdvancedMD row ${row.inputRow}: starting field fill sequence.`,
            eventName: "payment_posting_advancedmd_row_start",
            rowIndex: row.inputRow,
          });
          const prepared = await prepareAdvancedMdPaymentPostingRow({
            page,
            credentials,
            row,
            selectors: ADVANCEDMD_PAYMENT_POSTING_SELECTORS,
            screenshotFolder,
            fieldLogger: async (event) => {
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
        } catch (error) {
          await context.log({
            level: "error",
            message: `AdvancedMD row ${row.inputRow}: automation failed during Payment Entry field processing. ${error instanceof Error ? error.message : String(error)}`,
            eventName: "payment_posting_advancedmd_row_failed",
            rowIndex: row.inputRow,
          });
          results.push(await automationFailedRow(context, page, screenshotFolder, row, error, startedAt));
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
  return {
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
}

function paymentPostingFailureResult(error: unknown): PaymentPostingResultRow["result"] {
  if (error instanceof AdvancedMdPatientNotFoundError) return "Patient Not Found";
  if (error instanceof AdvancedMdPatientNotSelectedError) return "Patient Not Selected";
  if (error instanceof AdvancedMdVisitClaimNotFoundError) return "Visit/Claim Not Found";
  return "Automation Failed";
}

function paymentPostingFailureBotMessage(error: unknown): string {
  if (error instanceof AdvancedMdPatientNotFoundError) return "Patient Not Found. No payment was submitted.";
  if (error instanceof AdvancedMdPatientNotSelectedError) return "Patient Not Selected. No payment was submitted.";
  if (error instanceof AdvancedMdVisitClaimNotFoundError) return "Visit/Claim Not Found. No payment was submitted.";
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
    ].filter(Boolean).join(", "),
    skippedFields: "Post action",
  };
}

async function saveUploadedFile(file: File, targetPath: string): Promise<void> {
  await fs.writeFile(targetPath, Buffer.from(await file.arrayBuffer()));
}
