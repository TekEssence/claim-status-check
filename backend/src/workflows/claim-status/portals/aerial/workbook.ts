import * as XLSX from "xlsx";
import { CLAIM_STATUS_OUTPUT_HEADERS, claimStatusOutputRows } from "../../output-columns";

type AerialValidation = {
  valid: boolean;
  errors: Array<{ message: string }>;
  normalized: {
    subscriberNo: string;
    serviceDate: string;
  };
};

type AerialValidationModule = {
  validateInputRow(row: Record<string, unknown>): AerialValidation;
};

const { validateInputRow } = require("./validation.js") as AerialValidationModule;

export type AerialInputRow = Record<string, unknown> & {
  input_row_id: number;
  Group: string;
  "Claim No": string;
  "Subscriber No": string;
  "Service Date": string;
  validation_status: "valid" | "invalid";
  validation_message: string;
  normalized: AerialValidation["normalized"];
  validation_errors: AerialValidation["errors"];
};

const FALLBACK_EXCEL_COLUMNS = {
  group: -1,
  claimNo: 0,
  subscriberNo: 7,
  serviceDate: 10,
};

export const AERIAL_INPUT_COLUMN_ALIASES = {
  Group: ["Group", "Group Name", "Medical Group"],
  "Claim No": ["Claim No", "Claim Number"],
  "Subscriber No": ["Subscriber No", "Subscriber Number", "Member ID"],
  "Service Date": ["Service Date", "Date of Service", "DOS"],
};

function normalizeHeader(value: unknown): string {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    // Retain JSON's previously accepted separator/casing aliases in the
    // shared workbook parser rather than renaming columns only for service.
    .replace(/[^a-z0-9]+/g, "");
}

function findHeaderIndex(headerRow: unknown[], aliases: string[], fallbackIndex: number): number {
  const normalizedAliases = aliases.map(normalizeHeader);
  const index = headerRow.findIndex((value) => normalizedAliases.includes(normalizeHeader(value)));
  return index >= 0 ? index : fallbackIndex;
}

export function readAerialInputWorkbookFromBuffer(buffer: ArrayBuffer): AerialInputRow[] {
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellDates: true,
  });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];

  if (!sheet) {
    throw new Error("Aerial input workbook does not contain any sheets.");
  }

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
  }) as unknown[][];
  // Correlation columns are transport metadata. Ignore them before positional
  // fallback so adding Client Row Ref cannot change a portal claim's meaning.
  // Both manual and generated workbooks use this same parser.
  const metadataColumns = new Set((matrix[0] ?? []).flatMap((header, index) =>
    ["clientrowref", "originalindex"].includes(normalizeHeader(header)) ? [index] : []));
  const claimMatrix = matrix.map(row => Array.from({ length: row.length }, (_, index) => row[index]).filter((_, index) => !metadataColumns.has(index)));
  const headerRow = claimMatrix[0] ?? [];
  const columns = {
    group: findHeaderIndex(headerRow, AERIAL_INPUT_COLUMN_ALIASES.Group, FALLBACK_EXCEL_COLUMNS.group),
    claimNo: findHeaderIndex(headerRow, AERIAL_INPUT_COLUMN_ALIASES["Claim No"], FALLBACK_EXCEL_COLUMNS.claimNo),
    subscriberNo: findHeaderIndex(headerRow, AERIAL_INPUT_COLUMN_ALIASES["Subscriber No"], FALLBACK_EXCEL_COLUMNS.subscriberNo),
    serviceDate: findHeaderIndex(headerRow, AERIAL_INPUT_COLUMN_ALIASES["Service Date"], FALLBACK_EXCEL_COLUMNS.serviceDate),
  };

  return claimMatrix
    .slice(1)
    .map((row, index) => ({
      input_row_id: index + 2,
      Group: columns.group >= 0 ? String(row[columns.group] || "").trim() : "",
      "Claim No": String(row[columns.claimNo] || ""),
      "Subscriber No": String(row[columns.subscriberNo] || ""),
      "Service Date": String(row[columns.serviceDate] || ""),
    }))
    .filter((row) => row["Subscriber No"] || row["Service Date"])
    .map((row) => {
      const validation = validateInputRow(row);
      return {
        ...row,
        validation_status: validation.valid ? "valid" : "invalid",
        validation_message: validation.errors.map((error) => error.message).join("; "),
        normalized: validation.normalized,
        validation_errors: validation.errors,
      };
    });
}

function buildOutputRows(rows: Record<string, any>[]): Record<string, unknown>[] {
  return rows.flatMap((row) => {
    const serviceLines = row.serviceLines && row.serviceLines.length ? row.serviceLines : [{}];

    return serviceLines.map((serviceLine: Record<string, unknown>, index: number) => ({
      input_row_id: row.inputRowId,
      input_claim_no: row.inputClaimNo || "",
      result_index: row.resultIndex || "",
      subscriber_no: row.subscriberNo,
      service_date: row.serviceDate,
      member_id: row.memberId || "",
      member_name: row.memberName || "",
      member_birth_date: row.memberBirthDate || "",
      member_sex: row.memberSex || "",
      member_address: row.memberAddress || "",
      member_phone: row.memberPhone || "",
      member_health_plan: row.memberHealthPlan || "",
      member_health_plan_benefit_option: row.memberHealthPlanBenefitOption || "",
      member_pcp: row.memberPcp || "",
      claim_number: row.claimNumber || "",
      claim_status: row.claimStatus || "",
      total_paid: row.totalPaid || "",
      final_status: row.finalStatus || "",
      date_received: row.dateReceived || "",
      reject_date: row.rejectDate || "",
      date_paid: row.datePaid || "",
      check_number: row.checkNumber || "",
      provider_details: row.providerDetails || "",
      service_line_number: serviceLine.serviceCode ? index + 1 : "",
      service_code: serviceLine.serviceCode || "",
      service_description: serviceLine.serviceDescription || "",
      service_line_date: serviceLine.serviceDate || "",
      billed: serviceLine.billed || "",
      contract: serviceLine.contract || "",
      disallowed_denied: serviceLine.disallowedDenied || "",
      copay_coinsurance: serviceLine.copayCoinsurance || "",
      deductible: serviceLine.deductible || "",
      adjustment: serviceLine.adjustment || "",
      paid: serviceLine.paid || "",
      service_line_details: serviceLine.details || "",
      result: row.result,
      notes: row.notes || "",
      extracted_at: row.extractedAt,
    }));
  });
}

function buildErrorRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows;
}

function buildAuditRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows;
}

export function createAerialOutputWorkbookBuffer(
  outputRows: Record<string, any>[],
  logs: { errorRows: Record<string, unknown>[]; auditRows: Record<string, unknown>[] },
): Buffer {
  const workbook = XLSX.utils.book_new();
  const rows = claimStatusOutputRows("aerial", buildOutputRows(outputRows));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows, { header: [...new Set([...rows.flatMap(Object.keys), ...CLAIM_STATUS_OUTPUT_HEADERS])] }), "Output");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(buildErrorRows(logs.errorRows)), "Error");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(buildAuditRows(logs.auditRows)), "Audit_Log");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
