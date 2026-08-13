import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import type { EligibilityInputRow, EligibilityResult } from "../../types";

export type WaystarEligibilityAuditLogEntry = {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  eventName?: string;
  message: string;
  rowIndex?: number;
};

export type WaystarEligibilityOutputEntry = {
  payerId?: string;
  payerName?: string;
  row?: EligibilityInputRow;
  result?: EligibilityResult;
  errorMessage?: string;
  status: "completed" | "failed" | "skipped" | "unsupported";
};

export type WaystarEligibilityWorkbookOptions = {
  inputRows?: EligibilityInputRow[];
  auditLog?: WaystarEligibilityAuditLogEntry[];
};

const OUTPUT_HEADERS = [
  "Patient Name",
  "DOB",
  "Subscriber No",
  "Portal",
  "Payer",
  "Eligibility Row",
  "Run Status",
  "Plan Name",
  "Plan Status",
  "Plan Date",
  "Payer Note",
  "Service Type",
  "Coverage Status",
  "Eff Date",
  "End Date",
  "Other Ins",
  "Other Ins Eff Date",
  "Bot Insurance Type",
  "Network",
  "Coinsurance",
  "Copay",
  "Deductible",
  "Deductible Remaining",
  "Deductible Met",
  "Co-Insurance",
  "Error",
  "Raw Result Text",
  "Processed At",
] as const;

const LOG_HEADERS = ["timestamp", "level", "event_name", "row_index", "message"] as const;
const NA_VALUE = "NA";
const BASE_ALLOWED_HEADERS = new Set<string>([
  "Patient Name",
  "DOB",
  "Subscriber No",
  "Portal",
  "Payer",
  "Eligibility Row",
  "Run Status",
  "Plan Name",
]);
const MEDICARE_ALLOWED_HEADERS = new Set<string>([
  ...BASE_ALLOWED_HEADERS,
  "Coverage Status",
  "Eff Date",
  "End Date",
  "Other Ins",
  "Other Ins Eff Date",
  "Bot Insurance Type",
]);
const MEDICARE_TEXAS_ALLOWED_HEADERS = new Set<string>([
  ...MEDICARE_ALLOWED_HEADERS,
  "Network",
  "Coinsurance",
  "Copay",
  "Deductible",
  "Deductible Met",
]);
const PHARMACY_ALLOWED_HEADERS = new Set<string>([
  ...BASE_ALLOWED_HEADERS,
  "Service Type",
  "Coverage Status",
]);

export async function createWaystarEligibilityOutputWorkbookBuffer(
  entries: WaystarEligibilityOutputEntry[],
  options: WaystarEligibilityWorkbookOptions = {},
): Promise<Buffer> {
  const workbook = XLSX.utils.book_new();
  const inputRows = buildInputRows(options.inputRows ?? []);
  const outputRows = entries.map((entry) => buildOutputRow(entry));
  const auditRows = buildAuditRows(options.auditLog ?? []);
  const errorRows = auditRows.filter((row) => ["WARN", "ERROR"].includes(String(row.level)));

  appendSheet(workbook, "Input", inputRows, collectHeaders(inputRows, ["Eligibility Row"]));
  appendSheet(workbook, "Output", outputRows, [...OUTPUT_HEADERS]);
  appendSheet(workbook, "Audit Log", auditRows, [...LOG_HEADERS]);
  appendSheet(
    workbook,
    "Error Log",
    errorRows.length > 0
      ? errorRows
      : [{ timestamp: new Date().toISOString(), level: "INFO", event_name: "summary", row_index: "", message: "No warnings or errors recorded." }],
    [...LOG_HEADERS],
  );

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return applyOutputHeaderStyle(buffer);
}

function appendSheet(workbook: XLSX.WorkBook, sheetName: string, rows: Record<string, unknown>[], headers: string[]): void {
  const normalizedRows = rows.length > 0
    ? rows.map((row) => Object.fromEntries(headers.map((header) => [header, row[header] ?? ""])))
    : [Object.fromEntries(headers.map((header) => [header, ""]))];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(normalizedRows, { header: headers }), sheetName);
}

function collectHeaders(rows: Record<string, unknown>[], preferredHeaders: string[]): string[] {
  const seen = new Set(preferredHeaders);
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) seen.add(key);
    }
  }
  return Array.from(seen);
}

function buildInputRows(rows: EligibilityInputRow[]): Record<string, unknown>[] {
  return rows
    .slice()
    .sort((left, right) => left.originalIndex - right.originalIndex)
    .map((row) => ({
      "Eligibility Row": row.originalIndex,
      ...row.raw,
    }));
}

function buildAuditRows(entries: WaystarEligibilityAuditLogEntry[]): Record<string, unknown>[] {
  return entries.map((entry) => ({
    timestamp: entry.timestamp,
    level: entry.level.toUpperCase(),
    event_name: entry.eventName ?? "",
    row_index: entry.rowIndex ?? "",
    message: entry.message,
  }));
}

function buildOutputRow(entry: WaystarEligibilityOutputEntry): Record<string, unknown> {
  const raw = entry.row?.raw ?? {};
  const result = entry.result;
  const metadata = asRecord(result?.metadata);
  const portalFields = asRecord(metadata.portalFields);
  const bodyText = typeof metadata.bodyText === "string" ? metadata.bodyText : "";
  const benefitDate = parseBenefitDate(bodyText);
  const insuranceDisplayName = resolveInsuranceDisplayName(raw, entry.payerName);
  const serviceType = asText(portalFields.serviceType);

  const row: Record<string, unknown> = {
    "Patient Name": buildPatientName(entry.row),
    DOB: findRawValue(raw, ["DOB", "Date of Birth", "Patient DOB", "Patient Date Of Birth", "Birth Date"]) || (entry.row?.dateOfBirth ?? ""),
    "Subscriber No": findRawValue(raw, ["Subscriber No", "Subscriber #", "Subscriber ID", "Subscriber Number", "Primary Ins Subscriber No", "Primary Insurance Subscriber No", "Member ID", "Member #", "Member No"]) || (entry.row?.subscriberId ?? entry.row?.memberId ?? ""),
    Portal: "Waystar",
    Payer: insuranceDisplayName,
    "Eligibility Row": entry.row?.originalIndex ?? "",
    "Run Status": entry.status,
    "Plan Name": asText(portalFields.planName) || result?.planName || "",
    "Plan Status": asText(portalFields.planStatus) || result?.planStatus || "",
    "Plan Date": asText(portalFields.planDate),
    "Payer Note": asText(portalFields.payerNote),
    "Service Type": serviceType,
    "Coverage Status": firstNonEmpty(asText(portalFields.planStatus), result?.planStatus || "", findLabeledValue(bodyText, "Coverage Status")),
    "Eff Date": firstNonEmpty(findLabeledValue(bodyText, "Eligibility Date"), result?.effectiveDate || "", asText(portalFields.planDate)),
    "End Date": benefitDate.end,
    "Other Ins": findLabeledValue(bodyText, "Insurance Type"),
    "Other Ins Eff Date": benefitDate.start,
    "Bot Insurance Type": insuranceDisplayName,
    Network: result?.planType || "",
    Coinsurance: asText(portalFields.coInsurance),
    Copay: "",
    Deductible: asNumberOrText(portalFields.deductible),
    "Deductible Remaining": asNumberOrText(portalFields.deductibleRemaining),
    "Deductible Met": asNumberOrText(portalFields.deductibleMet),
    "Co-Insurance": asText(portalFields.coInsurance),
    Error: entry.errorMessage ?? "",
    "Raw Result Text": bodyText,
    "Processed At": new Date().toISOString(),
  };

  return applyOutputRules(normalizeOutputRow(row), insuranceDisplayName, serviceType);
}

function applyOutputRules(row: Record<string, unknown>, payerName: string, serviceType: string): Record<string, unknown> {
  const normalizedPayer = normalizeHeader(payerName);
  const normalizedServiceType = normalizeHeader(serviceType);

  if (normalizedServiceType === "pharmacy") {
    return keepOnlyAllowedColumns(row, PHARMACY_ALLOWED_HEADERS);
  }

  if (normalizedPayer === "medicare of texas") {
    return keepOnlyAllowedColumns(row, MEDICARE_TEXAS_ALLOWED_HEADERS);
  }

  if (normalizedPayer === "medicare") {
    return keepOnlyAllowedColumns(row, MEDICARE_ALLOWED_HEADERS);
  }

  return row;
}

function keepOnlyAllowedColumns(row: Record<string, unknown>, allowedHeaders: Set<string>): Record<string, unknown> {
  return Object.fromEntries(
    OUTPUT_HEADERS.map((header) => [header, allowedHeaders.has(header) ? row[header] ?? NA_VALUE : NA_VALUE]),
  );
}

function normalizeOutputRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeOutputValue(value)]),
  );
}

function normalizeOutputValue(value: unknown): number | string {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = asText(value);
  return text || NA_VALUE;
}

function buildPatientName(row: EligibilityInputRow | undefined): string {
  const raw = row?.raw ?? {};
  const explicit = findRawValue(raw, ["Patient Name", "Member Name", "Subscriber Name", "Patient Full Name", "Member Full Name", "Subscriber Full Name", "Patient"]);
  if (explicit) return explicit;
  const first = findRawValue(raw, ["Patient First Name", "First Name", "Pat F Name", "Pat First Name", "Patient Fname", "Member First Name", "Subscriber First Name", "Fname"]) || row?.patientFirstName || "";
  const last = findRawValue(raw, ["Patient Last Name", "Last Name", "Pat L Name", "Pat Last Name", "Patient Lname", "Member Last Name", "Subscriber Last Name", "Lname"]) || row?.patientLastName || "";
  return `${first} ${last}`.trim();
}

function findRawValue(raw: Record<string, unknown>, candidates: string[]): string {
  const entries = Object.entries(raw);
  for (const candidate of candidates) {
    const match = entries.find(([key]) => normalizeHeader(key) === normalizeHeader(candidate));
    const value = asText(match?.[1]);
    if (value) return value;
  }
  return "";
}

function resolveInsuranceDisplayName(raw: Record<string, unknown>, fallbackPayerName?: string): string {
  const insuranceName = findRawValue(raw, [
    "Primary Insurance Name",
    "Primary Insurance",
    "Primary Insurance Payer",
    "Primary Insurance Payer State",
    "Payer",
    "Payer Name",
    "Payer State",
    "Insurance Name",
    "Insurance Payer",
    "Insurance Payer State",
    "Insurance",
    "Current Insurance Plan",
  ]);
  const normalized = normalizeHeader(insuranceName);
  if (normalized.includes("medicare of texas")) return "Medicare of Texas";
  if (
    normalized === "medicare" ||
    normalized.includes("traditional medicare") ||
    normalized.includes("original medicare") ||
    normalized.includes("medicare part a") ||
    normalized.includes("medicare part b")
  ) {
    return "Medicare";
  }
  return insuranceName || fallbackPayerName || "";
}

function parseBenefitDate(bodyText: string): { start: string; end: string } {
  const value = findLabeledValue(bodyText, "Benefit Date");
  if (!value) return { start: "", end: "" };
  const matches = Array.from(value.matchAll(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g)).map((match) => match[0] ?? "").filter(Boolean);
  if (matches.length >= 2) return { start: matches[0] || "", end: matches[1] || "" };
  return { start: matches[0] || value, end: NA_VALUE };
}

function findLabeledValue(bodyText: string, label: string): string {
  const lines = bodyText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const labelIndex = lines.findIndex((line) => normalizeHeader(line) === normalizeHeader(label));
  if (labelIndex >= 0) {
    for (let index = labelIndex + 1; index < Math.min(lines.length, labelIndex + 4); index += 1) {
      const candidate = lines[index] || "";
      if (candidate) return candidate;
    }
  }

  const escapedLabel = escapeRegExp(label);
  const flattened = bodyText.replace(/\s+/g, " ");
  const match = flattened.match(new RegExp(`${escapedLabel}\s*([A-Za-z0-9/&(),.%\-\s]+?)(?=\s+(?:Payer Returned Information|Other Coverage Information|Plan Sponsor|Payer|Status|Phone|URL|Insurance Type|Benefit Date|Plan Number|Plan Network ID Number|Service Type|Deductible Remaining|Yearly Deductible|Coverage Status|Eligibility Date|$))`, "i"));
  return match?.[1]?.replace(/\s+/g, " ").trim() || "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim()) || "";
}

async function applyOutputHeaderStyle(buffer: Buffer): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet("Output");
  if (!worksheet) {
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  styleHeaderRow(worksheet.getRow(1));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function styleHeaderRow(row: ExcelJS.Row): void {
  for (let index = 1; index <= row.cellCount; index += 1) {
    const headerCell = row.getCell(index);
    headerCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF5B9BD5" },
    };
    headerCell.font = {
      ...headerCell.font,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function asText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function asNumberOrText(value: unknown): number | string {
  return typeof value === "number" && Number.isFinite(value) ? value : asText(value);
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
