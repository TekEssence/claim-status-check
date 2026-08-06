import ExcelJS from "exceljs";
import type { PaymentPostingInputRow } from "../../types";

export const PAYMENT_POSTING_INPUT_ALIASES = {
  patientName: ["Patient Name"],
  patientId: ["Patient ID"],
  patientControlNumber: ["Patient Control Number"],
  checkNumber: ["Check #"],
  checkDate: ["Deposit Date"],
  payerName: ["Payer Name"],
  carrier: ["Carrier"],
  checkAmount: ["Check Amount"],
  visitDateDos: ["DOS"],
  cpt: ["CPT"],
  chargeAmount: ["Charge"],
  allowedAmount: ["Insurance Allowed"],
  paymentAmount: ["Payment"],
  adjustment: ["Adjustment"],
  denialCode: ["Denial Code"],
  denialReason: ["Denial Reason"],
  remarkCode: ["Remark Code"],
  remarkReason: ["Remark Reason"],
} as const;

export async function readAdvancedMdPaymentPostingInput(file: File): Promise<PaymentPostingInputRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The Payment Posting input workbook does not contain a worksheet.");

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = asText(cell.value).replace(/\s+/g, " ").trim();
  });

  const rows: PaymentPostingInputRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw: Record<string, string> = {};
    headers.forEach((header, colNumber) => {
      if (header) raw[header] = asText(row.getCell(colNumber).value);
    });
    if (!Object.values(raw).some(Boolean)) return;
    rows.push(mapInputRow(raw, rowNumber));
  });

  if (!rows.length) throw new Error("The Payment Posting input workbook is empty.");
  return rows;
}

export function mapInputRow(raw: Record<string, string>, inputRow: number): PaymentPostingInputRow {
  const row: PaymentPostingInputRow = {
    inputRow,
    checkNumber: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.checkNumber),
    payerName: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.payerName),
    carrier: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.carrier),
    checkAmount: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.checkAmount),
    checkDate: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.checkDate),
    patientName: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.patientName),
    patientId: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.patientId),
    patientControlNumber: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.patientControlNumber),
    visitClaimNumber: "",
    visitDateDos: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.visitDateDos),
    cpt: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.cpt),
    chargeAmount: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.chargeAmount),
    paymentAmount: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.paymentAmount),
    allowedAmount: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.allowedAmount) || undefined,
    adjustment: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.adjustment) || undefined,
    carc: undefined,
    rarc: undefined,
    denialCode: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.denialCode) || undefined,
    denialReason: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.denialReason) || undefined,
    remarkCode: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.remarkCode) || undefined,
    remarkReason: findValue(raw, PAYMENT_POSTING_INPUT_ALIASES.remarkReason) || undefined,
    adjustmentCode: undefined,
    raDenialCode: undefined,
    status: undefined,
    modifier: undefined,
    units: undefined,
    provider: undefined,
    raw,
    validationErrors: [],
  };

  row.validationErrors = validatePaymentPostingInputRow(row);
  return row;
}

export function validatePaymentPostingInputRow(row: PaymentPostingInputRow): string[] {
  const errors: string[] = [];
  if (!row.checkNumber) errors.push("Check # is required.");
  if (!row.carrier) errors.push("Carrier is required.");
  if (!row.payerName) errors.push("Payer Name is required.");
  if (!row.checkAmount) errors.push("Check Amount is required.");
  if (!row.checkDate) errors.push("Deposit Date is required.");
  if (!row.patientName) errors.push("Patient Name is required.");
  if (!row.patientId) errors.push("Patient ID is required.");
  if (!row.visitDateDos) errors.push("DOS is required.");
  if (!row.cpt) errors.push("CPT is required.");
  if (!row.chargeAmount) errors.push("Charge is required.");
  if (!row.paymentAmount) errors.push("Payment is required.");
  return errors;
}

function findValue(row: Record<string, string>, aliases: readonly string[]): string {
  const wanted = new Set(aliases.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(key)) && value.trim()) return value.trim();
  }
  return "";
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function asText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  if (typeof value === "object" && "result" in value) return asText((value as { result?: unknown }).result);
  return String(value).trim();
}
