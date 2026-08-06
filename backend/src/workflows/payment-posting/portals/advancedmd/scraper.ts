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
import { readAdvancedMdPaymentPostingInput } from "./input";
import { createPaymentPostingOutputWorkbookBuffer } from "./output-builder";
import {
  ADVANCEDMD_PAYMENT_POSTING_SELECTORS,
  AdvancedMdMissingSelectorError,
  AdvancedMdScreenshotError,
  dismissAdvancedMdNotifications,
  loginToAdvancedMd,
  openAdvancedMdQuickPay,
  prepareAdvancedMdPaymentPostingRow,
  resolveAdvancedMdAppPage,
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
    await context.log({
      level: "info",
      message: `Payment Posting dry run loaded credentials for ${credentials.username} and ${rows.length} input row(s). Starting AdvancedMD browser automation.`,
      eventName: "payment_posting_validation_complete",
    });

    await runPortalRows(context, folders.screenshots, credentials, rows, results);

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
): Promise<void> {
  const session = await launchAutomationBrowser();
  let page = session.context.pages()[0] ?? await session.context.newPage();
  try {
    await loginToAdvancedMd(page, credentials, ADVANCEDMD_PAYMENT_POSTING_SELECTORS);
    await dismissAdvancedMdNotifications(page, ADVANCEDMD_PAYMENT_POSTING_SELECTORS);
    page = await resolveAdvancedMdAppPage(page);
    await openAdvancedMdQuickPay(page, ADVANCEDMD_PAYMENT_POSTING_SELECTORS);

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
        await context.emit({ type: "progress", completed: index, total: rows.length });
        await context.emit({ type: "cancelled", message: "Payment Posting dry run cancelled." });
        break;
      }

      if (row.validationErrors.length > 0) {
        results.push(validationFailedRow(context, row, startedAt));
      } else {
        try {
          const prepared = await prepareAdvancedMdPaymentPostingRow({
            page,
            credentials,
            row,
            selectors: ADVANCEDMD_PAYMENT_POSTING_SELECTORS,
            screenshotFolder,
          });
          results.push(filledNotPostedRow(context, row, prepared, startedAt));
          await resetAdvancedMdPaymentEntry(page);
        } catch (error) {
          results.push(automationFailedRow(context, row, error, startedAt));
        }
      }

      await context.emit({ type: "progress", completed: index + 1, total: rows.length });
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

function validationFailedRow(
  context: AutomationContext,
  row: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>[number],
  startedAt: string,
): PaymentPostingResultRow {
  return createBaseResultRow({
    input: row,
    portal: advancedMdPaymentPostingConfig.name,
    jobId: context.jobId,
    result: "Validation Failed",
    botMessage: "Input row failed strict validation.",
    errorDetails: row.validationErrors.join(" "),
    startedAt,
  });
}

function automationFailedRow(
  context: AutomationContext,
  row: Awaited<ReturnType<typeof readAdvancedMdPaymentPostingInput>>[number],
  error: unknown,
  startedAt: string,
): PaymentPostingResultRow {
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
        botMessage: "AdvancedMD row was filled, but screenshot capture failed before posting. No payment was posted.",
        errorDetails: message,
        startedAt,
        screenshotFilename: error.screenshotFilename,
      }),
      screenshotPath: error.screenshotPath,
      screenshotStatus: "Failed",
    };
  }
  return createBaseResultRow({
    input: row,
    portal: advancedMdPaymentPostingConfig.name,
    jobId: context.jobId,
    result: "Automation Failed",
    botMessage: "AdvancedMD dry-run automation stopped before posting. No payment was posted.",
    errorDetails: selectorDetails,
    startedAt,
    screenshotFilename: buildPaymentPostingScreenshotFilename(row),
  });
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
