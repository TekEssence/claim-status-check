import ExcelJS from "exceljs";
import type { ServiceResultSummary, ServiceRowResult, ServiceRowStatus } from "./iehp-results";

function text(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  return String(value).trim();
}

function headings(sheet: ExcelJS.Worksheet): Map<string, number> {
  const result = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => result.set(text(cell.value), column));
  return result;
}

function rowErrors(workbook: ExcelJS.Workbook): Map<number, string> {
  const sheet = workbook.getWorksheet("Error Log");
  const errors = new Map<number, string>();
  if (!sheet) return errors;
  const columns = headings(sheet);
  const rowColumn = columns.get("Row");
  const errorColumn = columns.get("Error");
  if (!rowColumn || !errorColumn) return errors;
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const line = sheet.getRow(index);
    const row = Number(text(line.getCell(rowColumn).value));
    const error = text(line.getCell(errorColumn).value);
    if (Number.isSafeInteger(row) && row >= 2 && error) errors.set(row, error);
  }
  return errors;
}

export async function normalizeEligibilityServiceWorkbook(
  bytes: Uint8Array,
  expectedRefs: string[],
): Promise<ServiceResultSummary> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Output");
  if (!sheet) throw new Error("Eligibility output workbook is missing the Output worksheet.");
  const columns = headings(sheet);
  const refColumn = columns.get("Client Row Ref");
  const coverageColumn = columns.get("Coverage Status");
  if (!refColumn || !coverageColumn) throw new Error("Eligibility output workbook is missing Client Row Ref or Coverage Status.");
  const errors = rowErrors(workbook);
  const expected = new Set(expectedRefs);
  const byRef = new Map<string, ServiceRowResult>();
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    const ref = text(row.getCell(refColumn).value);
    if (!ref) continue;
    if (!expected.has(ref) || byRef.has(ref)) throw new Error(`Eligibility output has an unexpected or duplicate Client Row Ref: ${ref}.`);
    const coverage = text(row.getCell(coverageColumn).value).toLowerCase();
    const output: Record<string, string> = {};
    for (const [header, column] of columns) {
      if (["Client Row Ref", "Project", "Primary Insurance Name", "Patient Name", "Member ID", "DOB", "DOS"].includes(header)) continue;
      const value = text(row.getCell(column).value);
      if (value && value !== "-") output[header] = value;
    }
    const inlineErrorColumn = columns.get("error");
    const error = errors.get(index) || (inlineErrorColumn ? text(row.getCell(inlineErrorColumn).value) : "");
    let status: ServiceRowStatus = "INCOMPLETE";
    if (coverage === "active" || coverage === "inactive") status = "SUCCESS";
    else if (/otp|mfa|verification required|action required/i.test(error)) status = "ACTION_REQUIRED";
    else if (/no (?:matching )?member|member not found|subscriber not found/i.test(error)) status = "NO_MATCH";
    else if (coverage === "error" || coverage === "unknown" || error) status = "FAILED";
    else if (coverage) status = "FAILED";
    const failureMessage = error || (status === "FAILED" ? "Eligibility response did not establish active or inactive coverage." : "");
    byRef.set(ref, {
      client_row_ref: ref,
      status,
      result: { coverage_status: coverage === "active" || coverage === "inactive" ? coverage : null, details: output },
      error_category: status === "SUCCESS" ? null : status === "ACTION_REQUIRED" ? "MANUAL_ACTION_REQUIRED" : status,
      error_message: status === "SUCCESS" ? null : failureMessage || null,
    });
  }
  if (byRef.size !== expected.size) throw new Error(`Eligibility output contains ${byRef.size} of ${expected.size} expected rows.`);
  const rowResults = expectedRefs.map((ref) => byRef.get(ref)!);
  const firstIncomplete = rowResults.findIndex((row) => row.status === "INCOMPLETE");
  const counts = {
    total: rowResults.length,
    success: rowResults.filter((row) => row.status === "SUCCESS").length,
    no_match: rowResults.filter((row) => row.status === "NO_MATCH").length,
    failed: rowResults.filter((row) => row.status === "FAILED").length,
    action_required: rowResults.filter((row) => row.status === "ACTION_REQUIRED").length,
    incomplete: rowResults.filter((row) => row.status === "INCOMPLETE").length,
  };
  return {
    outcome: counts.success === counts.total ? "SUCCESS" : counts.success > 0 ? "PARTIAL_SUCCESS" : "FAILED",
    counts,
    row_results: rowResults,
    finalized_count: firstIncomplete < 0 ? rowResults.length : firstIncomplete,
  };
}
