import ExcelJS from "exceljs";
import type { ServiceResultSummary, ServiceRowResult, ServiceRowStatus } from "./iehp-results";
import { incompleteServiceResult, summarizeServiceResults } from "./result-summary";

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
  options: { requireStatusColumns?: boolean; unfinishedAsPending?: boolean; portal?: string } = {},
): Promise<ServiceResultSummary> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  let sheet = workbook.getWorksheet("Output");
  // Older workers saved partial rows separately from the original inputs.
  // This path is used only by stopped-task recovery, never ordinary polling.
  if (!sheet && options.unfinishedAsPending) {
    const input = workbook.getWorksheet("Input");
    const partial = workbook.getWorksheet("Partial Results");
    if (input && partial) {
      const inputColumns = headings(input);
      const partialColumns = headings(partial);
      const excelRow = partialColumns.get("Excel Row");
      if (!excelRow) throw new Error("Eligibility partial output is missing Excel Row.");
      sheet = workbook.addWorksheet("Output");
      const headers = [...new Set([...inputColumns.keys(), ...partialColumns.keys()])].filter(header => header !== "Excel Row");
      sheet.addRow(headers);
      for (let index = 2; index <= partial.rowCount; index++) {
        const row = partial.getRow(index);
        const sourceIndex = Number(text(row.getCell(excelRow).value));
        if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 2 || sourceIndex > input.rowCount) throw new Error("Eligibility partial output has an invalid Excel Row.");
        sheet.addRow(headers.map(header => partialColumns.has(header)
          ? row.getCell(partialColumns.get(header)!).value : input.getRow(sourceIndex).getCell(inputColumns.get(header)!).value));
      }
    }
  }
  sheet ??= options.portal === "uhc" ? workbook.worksheets[0] : undefined;
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
    const coverage = text(row.getCell(coverageColumn).value).toLowerCase().replace(/^(active|inactive) coverage$/, "$1");
    const output: Record<string, string> = {};
    for (const [header, column] of columns) {
      if (["Client Row Ref", "Project", "Primary Insurance Name", "Patient Name", "Member ID", "DOB", "DOS"].includes(header)) continue;
      const value = text(row.getCell(column).value);
      if (value && value !== "-") output[header] = value;
    }
    const inlineErrorColumn = columns.get("error") ?? (options.portal === "uhc" ? columns.get("Error") : undefined);
    const error = (errors.get(index) || (inlineErrorColumn ? text(row.getCell(inlineErrorColumn).value) : "")).replace(/^-$/, "");
    if (options.unfinishedAsPending && /^(?:Cancelled|Pending) - not processed$|^Eligibility row was not processed before output was created\.$|^Eligibility run was cancelled before this row was processed\.$/i.test(error)) {
      byRef.set(ref, incompleteServiceResult(ref));
      continue;
    }
    let status: ServiceRowStatus = "INCOMPLETE";
    if ((coverage === "active" || coverage === "inactive") && !(options.portal === "uhc" && error)) status = "SUCCESS";
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
  if ((options.requireStatusColumns ?? true) && byRef.size !== expected.size) throw new Error(`Eligibility output contains ${byRef.size} of ${expected.size} expected rows.`);
  return summarizeServiceResults(expectedRefs.map(ref => byRef.get(ref) ?? incompleteServiceResult(ref)));
}
