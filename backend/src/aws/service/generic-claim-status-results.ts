import ExcelJS from "exceljs";
import { type loadServiceExpectedRefs, type ServiceWorkbookArtifact } from "./iehp-snapshot";
import { loadWorkerResultSnapshot } from "./worker-result-snapshot";
import type { ServiceResultSummary, ServiceRowResult, ServiceRowStatus } from "./iehp-results";
import type { GenericClaimStatusServicePortalId } from "./generic-claim-status-input";
import { summarizeServiceResults } from "./result-summary";
import { claimStatusResultFields } from "./claim-status-result-fields";
import { classifyClaimCompletion } from "./claim-completion";

type ServiceJob = Parameters<typeof loadServiceExpectedRefs>[0];
type Detail = Record<string, string>;
const ROW_NUMBER_HEADERS = ["input_row_id", "input_row_number", "Input Row", "inputRowId", "sno"];

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.formula ? cell.result : cell.value;
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "").trim();
  return String(value).trim();
}

function sheetRows(sheet: ExcelJS.Worksheet | undefined): Detail[] {
  if (!sheet) return [];
  const headers: string[] = [];
  sheet.getRow(1).eachCell((cell, column) => { headers[column] = cellText(cell); });
  const rows: Detail[] = [];
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const record: Detail = {};
    // Retain blank worker columns: an empty Bot Status must not fall back to
    // an input/adjudication Status cell from the submitted workbook.
    headers.forEach((header, column) => {
      if (header) record[header] = cellText(sheet.getRow(index).getCell(column));
    });
    if (Object.values(record).some(Boolean)) rows.push(record);
  }
  return rows;
}

function sourceRef(row: Detail, expectedRefs: string[], portalId: GenericClaimStatusServicePortalId): string | null {
  const direct = row["Client Row Ref"];
  if (direct) {
    if (!expectedRefs.includes(direct)) throw new Error(`${portalId} output has an unexpected Client Row Ref.`);
    return direct;
  }
  const header = ROW_NUMBER_HEADERS.find((name) => row[name]);
  if (!header) return null;
  const number = Number.parseInt(row[header], 10);
  if (!Number.isInteger(number)) return null;
  const index = number - (header === "sno" || (portalId === "waystar" && header === "Input Row") ? 1 : 2);
  if (index < 0 || index >= expectedRefs.length) throw new Error(`${portalId} output has an unexpected input row number.`);
  return expectedRefs[index];
}

function normalizedClaim(ref: string, rows: Detail[], errors: Detail[], portal: GenericClaimStatusServicePortalId): ServiceRowResult {
  if (!rows.length && !errors.length) return {
    client_row_ref: ref, status: "INCOMPLETE", result: { claim_status: "", claim_details: "" },
    error_category: "INCOMPLETE", error_message: null,
  };
  const outcomes = rows.map(row => classifyClaimCompletion(portal, row));
  const errorMessages = errors.flatMap((row) => Object.entries(row)
    .filter(([key]) => /error|reason|message|description/i.test(key)).map(([, value]) => value)).filter(Boolean);
  const status: ServiceRowStatus = outcomes.some((item) => item.status === "INCOMPLETE") ? "INCOMPLETE"
    : outcomes.some((item) => item.status === "ACTION_REQUIRED") ? "ACTION_REQUIRED"
    : errorMessages.length || outcomes.some((item) => item.status === "FAILED") ? "FAILED"
      : outcomes.length && outcomes.every((item) => item.status === "NO_MATCH") ? "NO_MATCH"
          : outcomes.length ? "SUCCESS" : "FAILED";
  const details = [...new Set(rows.map((row) => row["Claim Status - Final Status"] || row.final_status || row["Final Status"] || row["Claim Status"] || row.BotClaimStatus || "").filter(Boolean))];
  const claimStatuses = [...new Set(rows.map((row) => row["Claim Status"] || row.BotClaimStatus || row.claim_outcome || row.status || "").filter(Boolean))];
  const message = [...new Set([...outcomes.map((item) => item.reason), ...errorMessages].filter(Boolean))].join(" | ");
  return {
    client_row_ref: ref,
    status,
    result: { claim_status: claimStatuses.join("; "), claim_details: details.join("\n\n"), detail_rows: rows },
    error_category: status === "SUCCESS" ? null : status === "ACTION_REQUIRED" ? "MANUAL_ACTION_REQUIRED" : status,
    error_message: status === "SUCCESS" ? null : message || null,
  };
}

export async function normalizeGenericClaimStatusWorkbook(
  bytes: Uint8Array, expectedRefs: string[], portalId: GenericClaimStatusServicePortalId,
): Promise<ServiceResultSummary> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const output = book.getWorksheet("Output") ?? (portalId === "uhc" ? book.worksheets[0] : undefined);
  if (!output) throw new Error(`${portalId} output workbook is missing the Output worksheet.`);
  const grouped = new Map<string, Detail[]>();
  const errors = new Map<string, Detail[]>();
  let waystarRef: string | null = null;
  for (const row of sheetRows(output)) {
    const directRef = sourceRef(row, expectedRefs, portalId);
    if (portalId === "waystar" && directRef) waystarRef = directRef;
    const ref = directRef ?? (portalId === "waystar" ? waystarRef : null);
    if (ref) grouped.set(ref, [...(grouped.get(ref) ?? []), row]);
  }
  for (const name of ["Error", "Error Log"]) {
    for (const row of sheetRows(book.getWorksheet(name))) {
      const ref = sourceRef(row, expectedRefs, portalId);
      if (ref) errors.set(ref, [...(errors.get(ref) ?? []), row]);
    }
  }
  const rowResults = expectedRefs.map((ref) => {
    const row = normalizedClaim(ref, grouped.get(ref) ?? [], errors.get(ref) ?? [], portalId);
    return { ...row, result: claimStatusResultFields(portalId, row.result) };
  });
  return summarizeServiceResults(rowResults);
}

export async function loadGenericClaimStatusSnapshot(
  _portalId: GenericClaimStatusServicePortalId, job: ServiceJob,
): Promise<{ expectedRefs: string[]; summary: ServiceResultSummary | null; artifact: ServiceWorkbookArtifact | null; recorded: boolean }> {
  void _portalId; // Compatibility argument; publication no longer branches by portal.
  return loadWorkerResultSnapshot(job);
}
