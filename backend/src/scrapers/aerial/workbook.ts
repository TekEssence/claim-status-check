import * as XLSX from "xlsx";

type AerialLegacyValidation = {
  valid: boolean;
  errors: Array<{ message: string }>;
  normalized: {
    subscriberNo: string;
    serviceDate: string;
  };
};

type AerialLegacyValidationModule = {
  validateInputRow(row: Record<string, unknown>): AerialLegacyValidation;
};

const { validateInputRow } = require("./legacy/validation.js") as AerialLegacyValidationModule;

export type AerialInputRow = Record<string, unknown> & {
  input_row_id: number;
  "Subscriber No": string;
  "Service Date": string;
  validation_status: "valid" | "invalid";
  validation_message: string;
  normalized: AerialLegacyValidation["normalized"];
  validation_errors: AerialLegacyValidation["errors"];
};

const EXCEL_COLUMNS = {
  subscriberNo: 7,
  serviceDate: 10,
};

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

  return matrix
    .slice(1)
    .map((row, index) => ({
      input_row_id: index + 2,
      "Subscriber No": String(row[EXCEL_COLUMNS.subscriberNo] || ""),
      "Service Date": String(row[EXCEL_COLUMNS.serviceDate] || ""),
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
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(buildOutputRows(outputRows)), "Output");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(buildErrorRows(logs.errorRows)), "Error");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(buildAuditRows(logs.auditRows)), "Audit_Log");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
