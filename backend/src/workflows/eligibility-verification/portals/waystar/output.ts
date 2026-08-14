import ExcelJS from "exceljs";
import type { EligibilityInputRow, EligibilityResult } from "../../types";

const LEGACY_OUTPUT_COLUMNS: Array<{
  header: string;
  value: (row: EligibilityInputRow | undefined, result: EligibilityResult | undefined, error: string | undefined) => unknown;
}> = [
  { header: "Bot Entered Relationship to Subscriber", value: (row, result) => result?.relationshipToSubscriber || row?.relationshipToSubscriber || "Self" },
  { header: "Bot Coverage Status", value: (_row, result) => result?.coverageStatus ?? "" },
  { header: "Bot Network", value: (_row, result) => result?.inOutNetwork ?? "" },
  { header: "Bot Plan Type", value: (_row, result) => result?.planType ?? "" },
  { header: "Bot Plan Name", value: (_row, result) => result?.planName ?? "" },
  { header: "Bot Effective Date", value: (_row, result) => result?.effectiveDate ?? "" },
  { header: "Bot Termination Date", value: (_row, result) => result?.terminationDate ?? "" },
  { header: "Bot Premium Paid End Date", value: (_row, result) => result?.premiumPaidEndDate ?? "" },
  { header: "Bot Insurance Type", value: (_row, result) => result?.insuranceType ?? "" },
  { header: "Bot Group Number", value: (_row, result) => result?.groupNumber ?? "" },
  { header: "Bot Plan Date", value: (_row, result) => result?.planDate ?? "" },
  { header: "Bot Primary Care Provider", value: (_row, result) => result?.primaryCareProvider ?? "" },
  { header: "Bot IPA", value: (_row, result) => result?.ipa ?? "" },
  { header: "Bot Coverage Description", value: (_row, result) => result?.coverageDescription ?? "" },
  { header: "Bot Coinsurance", value: (_row, result) => result?.coinsurance ?? "" },
  { header: "Bot Copay", value: (_row, result) => result?.copay ?? "" },
  { header: "Bot Deductible", value: (_row, result) => result?.deductible ?? "" },
  { header: "Bot Deductible Met", value: (_row, result) => result?.deductibleMet ?? "" },
  { header: "Bot Out of Pocket", value: (_row, result) => result?.outOfPocket ?? "" },
  { header: "Bot Out of Pocket Met", value: (_row, result) => result?.outOfPocketMet ?? "" },
  { header: "Bot Payer Note", value: (_row, result) => result?.specialistPayerNote ?? "" },
  {
    header: "Bot Benefits",
    value: (_row, result) => result?.benefits
      .map((benefit) => `${benefit.serviceType}: ${benefit.coverageStatus}${benefit.notes ? ` (${benefit.notes})` : ""}`)
      .join(" | ") ?? "",
  },
  { header: "Bot Error", value: (_row, _result, error) => error ?? "" },
];


const BCBS_OUTPUT_COLUMNS = [LEGACY_OUTPUT_COLUMNS[1], LEGACY_OUTPUT_COLUMNS[5], LEGACY_OUTPUT_COLUMNS[6], LEGACY_OUTPUT_COLUMNS[8], LEGACY_OUTPUT_COLUMNS[8], LEGACY_OUTPUT_COLUMNS[0], LEGACY_OUTPUT_COLUMNS[3], LEGACY_OUTPUT_COLUMNS[8]].map((column) => ({ ...column }));

BCBS_OUTPUT_COLUMNS[0].header = "Coverage Status";
BCBS_OUTPUT_COLUMNS[1] = { header: "Eff Date", value: (_row, result) => splitOutputDateRange(result?.effectiveDate).effectiveDate };
BCBS_OUTPUT_COLUMNS[2] = { header: "End Date", value: (_row, result) => result?.terminationDate || splitOutputDateRange(result?.effectiveDate).endDate || "" };
BCBS_OUTPUT_COLUMNS[3] = { header: "Other Ins", value: (_row, result) => result?.otherInsurance || "" };
BCBS_OUTPUT_COLUMNS[4] = { header: "Other Ins Eff Date", value: (_row, result) => result?.otherInsuranceEffectiveDate || "" };
BCBS_OUTPUT_COLUMNS[5].header = "Relationship to Subscriber";
BCBS_OUTPUT_COLUMNS[6].header = "Plan Type";
BCBS_OUTPUT_COLUMNS[7].header = "Bot Insurance Type";
function splitOutputDateRange(value?: string): { effectiveDate: string; endDate: string } {
  const [effectiveDate = "", endDate = ""] = (value ?? "").split(/\s*\bto\b\s*/i, 2);
  return { effectiveDate: effectiveDate.trim(), endDate: endDate.trim() };
}
function formatOutputValue(value: unknown): unknown {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string" && value.trim() === "") return "-";
  return value;
}

export async function buildWaystarOutputWorkbook(options: {
  inputFile: File;
  rows: Map<number, EligibilityInputRow>;
  results: Map<number, EligibilityResult>;
  errors: Map<number, string>;
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await options.inputFile.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The eligibility workbook does not contain a worksheet.");

  const outputColumns = BCBS_OUTPUT_COLUMNS;
  const outputStartColumn = sheet.columnCount + 1;
  const headerRow = sheet.getRow(1);
  outputColumns.forEach((column, offset) => {
    const cell = headerRow.getCell(outputStartColumn + offset);
    cell.value = column.header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFB4C6E7" } },
      left: { style: "thin", color: { argb: "FFB4C6E7" } },
      bottom: { style: "thin", color: { argb: "FFB4C6E7" } },
      right: { style: "thin", color: { argb: "FFB4C6E7" } },
    };
    sheet.getColumn(outputStartColumn + offset).width = Math.max(14, Math.min(32, column.header.length + 2));
  });
  headerRow.height = Math.max(headerRow.height || 15, 30);

  const rowIndexes = new Set([
    ...options.rows.keys(),
    ...options.results.keys(),
    ...options.errors.keys(),
  ]);
  for (const rowIndex of rowIndexes) {
    const row = options.rows.get(rowIndex);
    const result = options.results.get(rowIndex);
    const error = options.errors.get(rowIndex);
    const worksheetRow = sheet.getRow(rowIndex);
    outputColumns.forEach((column, offset) => {
      const cell = worksheetRow.getCell(outputStartColumn + offset);
      cell.value = formatOutputValue(column.value(row, result, error)) as ExcelJS.CellValue;
cell.alignment = { vertical: "top", wrapText: true };
      if (outputColumns === BCBS_OUTPUT_COLUMNS) {
        cell.border = {
          top: { style: "thin", color: { argb: "FFD9E2F3" } },
          left: { style: "thin", color: { argb: "FFD9E2F3" } },
          bottom: { style: "thin", color: { argb: "FFD9E2F3" } },
          right: { style: "thin", color: { argb: "FFD9E2F3" } },
        };
      }
    });
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
