import ExcelJS from "exceljs";
import type { ServiceResultSummary, ServiceRowResult, ServiceRowStatus } from "./iehp-results";
import { summarizeServiceResults } from "./result-summary";
import { claimStatusResultFields } from "./claim-status-result-fields";
import { classifyClaimCompletion } from "./claim-completion";

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.formula ? cell.result : cell.value;
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "").trim();
  return String(value).trim();
}

function rowStatus(raw: string, notes: string): { status: ServiceRowStatus; category: string | null } {
  if (/^skipped$/i.test(raw) && /payer.*not supported|unsupported payer/i.test(notes)) return { status: "FAILED", category: "UNSUPPORTED_PAYER" };
  const { status } = classifyClaimCompletion("availity", { bot_overall_result: raw, bot_notes: notes });
  return { status, category: status === "SUCCESS" ? null : status === "ACTION_REQUIRED" ? "MANUAL_ACTION_REQUIRED"
    : status === "FAILED" ? /^skipped$/i.test(raw) ? "INVALID_INPUT" : "PORTAL_ERROR" : status };
}

function normalizeClaim(ref: string, rows: Array<Record<string, string>>): ServiceRowResult {
  if (!rows.length) {
    return {
      client_row_ref: ref, status: "INCOMPLETE",
      result: { claim_status: "", claim_details: "" },
      error_category: "INCOMPLETE", error_message: null,
    };
  }
  const outcomes = rows.map((row) => rowStatus(row.bot_overall_result ?? "", row.bot_notes ?? ""));
  const distinctStatuses = new Set(outcomes.map((item) => item.status));
  const status: ServiceRowStatus = outcomes.some((item) => item.status === "INCOMPLETE") ? "INCOMPLETE"
    : outcomes.some((item) => item.status === "ACTION_REQUIRED") ? "ACTION_REQUIRED"
      : distinctStatuses.size > 1 || outcomes.some((item) => item.status === "FAILED") ? "FAILED"
        : outcomes[0].status;
  const distinct = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const notes = distinct(rows.map((row) => row.bot_notes ?? ""));
  const details = distinct(rows.map((row) => row.bot_updated_claim_status ?? ""));
  const statuses = distinct(rows.map((row) => row.bot_overall_result ?? ""));
  return {
    client_row_ref: ref,
    status,
    result: {
      claim_status: statuses.join("; "),
      claim_details: details.join("\n\n"),
      detail_rows: rows,
    },
    error_category: status === "SUCCESS" ? null : outcomes.find((item) => item.status === status)?.category ?? "PORTAL_ERROR",
    error_message: status === "SUCCESS" ? null : notes.join(" | ") || null,
  };
}

export async function normalizeAvailityServiceWorkbook(
  bytes: Uint8Array,
  expectedRefs: string[],
  options: { requireStatusColumns?: boolean } = {},
): Promise<ServiceResultSummary> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Output");
  if (!sheet) throw new Error("Availity output workbook is missing the Output worksheet.");
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => headers.set(cellText(cell), column));
  const refColumn = headers.get("Client Row Ref");
  if (!refColumn) throw new Error("Availity output workbook is missing Client Row Ref.");
  if ((options.requireStatusColumns ?? true) && (!headers.has("bot_overall_result") || !headers.has("bot_updated_claim_status"))) {
    throw new Error("Availity output workbook is missing result columns.");
  }
  const expected = new Set(expectedRefs);
  const grouped = new Map<string, Array<Record<string, string>>>();
  for (let index = 2; index <= sheet.rowCount; index += 1) {
    const row = sheet.getRow(index);
    const ref = cellText(row.getCell(refColumn));
    if (!ref) continue;
    if (!expected.has(ref)) throw new Error(`Availity output has an unexpected Client Row Ref: ${ref}.`);
    const record: Record<string, string> = {};
    for (const [header, column] of headers) {
      if (header === "Client Row Ref" || header === "input_row_id") continue;
      const value = cellText(row.getCell(column));
      if (value) record[header] = value;
    }
    const existing = grouped.get(ref) ?? [];
    existing.push(record);
    grouped.set(ref, existing);
  }
  const rowResults = expectedRefs.map((ref) => {
    const row = normalizeClaim(ref, grouped.get(ref) ?? []);
    return { ...row, result: claimStatusResultFields("availity", row.result) };
  });
  return summarizeServiceResults(rowResults);
}
