import path from "node:path";
import { getJobDataPath } from "@/backend/src/core/storage";
import type { AutomationContext, AutomationRunner } from "../types";
import {
  PAYMENT_POSTING_DRY_RUN,
  PAYMENT_POSTING_RESULT_VALUES,
  PAYMENT_POSTING_WORKFLOW_ID,
  PROHIBITED_PAYMENT_POSTING_ACTION_IDS,
  type PaymentPostingInputRow,
  type PaymentPostingResultRow,
  type PaymentPostingResultValue,
  type PaymentPostingRunInput,
} from "./types";

export abstract class BasePaymentPostingRunner implements AutomationRunner<PaymentPostingRunInput> {
  readonly workflowId = PAYMENT_POSTING_WORKFLOW_ID;
  abstract readonly portalId: string;
  abstract readonly name: string;

  validateInput(input: unknown): PaymentPostingRunInput {
    if (!(input instanceof FormData)) {
      throw new Error("Payment Posting input must be multipart form data.");
    }
    return {
      credentialExcel: requireFile(input, "credentialExcel", "AdvancedMD credentials Excel"),
      inputExcel: requireFile(input, "inputExcel", "Payment Posting input Excel"),
    };
  }

  abstract run(input: PaymentPostingRunInput, context: AutomationContext): Promise<void>;
}

export type PaymentPostingRunFolders = {
  root: string;
  input: string;
  logs: string;
  screenshots: string;
  outputWorkbook: string;
};

export function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

export function createPaymentPostingRunFolders(jobId: string, date = new Date()): PaymentPostingRunFolders {
  const datePart = date.toISOString().slice(0, 10);
  const root = path.join(getJobDataPath(jobId, "outputs"), `PaymentPosting_${datePart}_${sanitizeFilenamePart(jobId, 80)}`);
  return {
    root,
    input: path.join(root, "Input"),
    logs: path.join(root, "Logs"),
    screenshots: path.join(root, "Screenshots"),
    outputWorkbook: path.join(root, "Output.xlsx"),
  };
}

export function sanitizeFilenamePart(value: string, maxLength = 80): string {
  const sanitized = value
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, "_")
    .replace(/\.+$/g, "")
    .trim();
  const fallback = sanitized || "value";
  return fallback.slice(0, Math.max(1, maxLength));
}

export function buildPaymentPostingScreenshotFilename(row: {
  inputRow: number;
  checkNumber?: string;
  patientName?: string;
  patientId?: string;
  visitClaimNumber?: string;
}): string {
  const parts = [
    sanitizeFilenamePart(row.patientName || row.patientId || "patient", 80),
    `row_${row.inputRow}`,
    row.checkNumber ? `check_${sanitizeFilenamePart(row.checkNumber, 40)}` : "",
    "not_posted",
  ].filter(Boolean);
  return `${parts.join("_")}.png`;
}

export function assertPaymentPostingActionAllowed(actionId: string): void {
  const normalized = actionId.toLowerCase().trim().replace(/[\s_]+/g, "-");
  if ((PROHIBITED_PAYMENT_POSTING_ACTION_IDS as readonly string[]).includes(normalized)) {
    throw new Error(`Payment Posting dry-run safety blocked prohibited action: ${actionId}`);
  }
}

export function isPaymentPostingResultValue(value: string): value is PaymentPostingResultValue {
  return (PAYMENT_POSTING_RESULT_VALUES as readonly string[]).includes(value);
}

export function decidePaymentPostingStatus(inputStatus?: string, reasonCodes: string[] = []): "Bill Next" | "Denied" {
  const combined = [inputStatus, ...reasonCodes].filter(Boolean).join(" ").toLowerCase();
  return /\b(denied|deny|denial|reject|rejected)\b/.test(combined) ? "Denied" : "Bill Next";
}

export function createBaseResultRow(options: {
  input: PaymentPostingInputRow;
  portal: string;
  jobId: string;
  result: PaymentPostingResultValue;
  botMessage: string;
  errorDetails?: string;
  startedAt: string;
  completedAt?: string;
  screenshotFilename?: string;
}): PaymentPostingResultRow {
  const completedAt = options.completedAt ?? new Date().toISOString();
  return {
    originalInput: options.input.raw,
    inputRow: options.input.inputRow,
    workflow: "Payment Posting",
    portal: options.portal,
    jobId: options.jobId,
    dryRun: PAYMENT_POSTING_DRY_RUN.dryRun,
    posted: PAYMENT_POSTING_DRY_RUN.posted,
    checkNumberInput: options.input.checkNumber,
    checkNumberEntered: "",
    payerNameInput: options.input.payerName,
    carrierSelected: "",
    carrierInput: options.input.carrier,
    checkAmountInput: options.input.checkAmount,
    checkAmountEntered: "",
    checkEftDateInput: options.input.checkDate,
    depositDateEntered: "",
    patientNameInput: options.input.patientName,
    patientIdInput: options.input.patientId,
    patientControlNumberInput: options.input.patientControlNumber,
    patientSelected: "",
    patientIdSelected: "",
    visitClaimInput: options.input.visitClaimNumber,
    visitClaimSelected: "",
    visitDateDos: options.input.visitDateDos,
    dosInputRaw: options.input.visitDateDos,
    dosInputShortFormat: "",
    dosInputFullFormat: "",
    dosInputCanonical: "",
    visitOptionsFoundCount: "",
    visitOptionsFound: "",
    visitComparisonDetails: "",
    visitDateSelected: "",
    visitTimeSelected: "",
    visitDateCanonical: "",
    dosMatch: "",
    visitMatchResult: "",
    paymentAmountInput: options.input.paymentAmount,
    paymentAmountEntered: "",
    excelCpt: options.input.cpt,
    lineItemCode: "",
    cptMatch: "No",
    excelChargeAmount: options.input.chargeAmount,
    lineItemCharge: "",
    chargeMatch: "No",
    lineMatchResult: "",
    insurancePortion: "",
    patientPortion: "",
    allowedAmountInput: options.input.allowedAmount ?? "",
    insuranceAllowedEntered: "",
    insuranceNotAllowed: "",
    paymentEntered: "",
    insuranceBalance: "",
    patientBalance: "",
    writeOffCode: "",
    writeOffAmount: "",
    adjustmentInput: options.input.adjustment ?? "",
    riskCode: "",
    riskAmount: "",
    carcInput: options.input.carc ?? "",
    carcSelected: "",
    rarcInput: options.input.rarc ?? "",
    rarcSelected: "",
    denialCodeInput: options.input.denialCode ?? "",
    denialCodeSelected: "",
    denialCodeDescription: "",
    reasonDescriptionSelected: "",
    statusInput: options.input.status ?? "",
    finalDisplayedStatus: "",
    provider: options.input.provider ?? "",
    screenshotFilename: options.screenshotFilename ?? "",
    screenshotPath: "",
    screenshotStatus: "",
    result: options.result,
    botMessage: options.botMessage,
    errorDetails: options.errorDetails ?? "",
    startedAt: options.startedAt,
    completedAt,
    processingTime: processingTime(options.startedAt, completedAt),
    filledFields: "",
    skippedFields: "",
  };
}

function processingTime(startedAt: string, completedAt: string): string {
  const start = Date.parse(startedAt);
  const end = Date.parse(completedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  return `${end - start}ms`;
}

export function downloadableFileEvent(filename: string, buffer: Buffer, mimeType: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: buffer.toString("base64"),
    mimeType,
  };
}
