import ExcelJS from "exceljs";
import type { ServiceResultSummary, ServiceRowResult, ServiceRowStatus } from "./service-contract";
import { incompleteServiceResult, summarizeServiceResults } from "./result-summary";
import { claimStatusResultFields } from "./claim-status-result-fields";
import { CLAIM_STATUS_OUTPUT_HEADERS } from "../../workflows/claim-status/output-columns";
import { classifyClaimCompletion } from "./claim-completion";
export { pageServiceResults, pageServiceResults as pageIehpServiceResults } from "./result-publication";
export type { ServiceOutcome, ServiceResultSummary, ServiceRowResult, ServiceRowStatus } from "./service-contract";

function cellText(cell: ExcelJS.Cell): string {
  // ExcelJS omits cached zero from cell.value for formulas; cell.result retains it.
  const value = cell.formula ? cell.result : cell.value;
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  if (typeof value === "object" && "result" in value) return String(value.result ?? "").trim();
  return String(value).trim();
}

const detailHeaders = new Set([
  ...CLAIM_STATUS_OUTPUT_HEADERS,
  "BotClaimDetails", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotReferRA",
  "SummaryBlockDOS", "SummaryBlockDate", "Check Number", "Bot CIN", "Received Date", "Check Date",
  "Bot Plan Type", "Billed Amount", "Other related payment details", "RA Proc Code", "RA Check Amount",
  "RA Amount Billed", "RA Amount Allowed", "RA Copay", "RA Coins", "RA Deduct Amount", "RA Net Paid",
  "RA Status", "RA Reason", "RA Denial Reason", "Final Status",
]);

type ClaimServiceRowResult = ServiceRowResult & {
  result: ServiceRowResult["result"] & { claim_status: string; claim_details: string };
};
type ParsedDetailRow = { normalized: ClaimServiceRowResult; detail: Record<string, string> };

function uniqueNonempty(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function groupClaimRows(ref: string, rows: ParsedDetailRow[]): ClaimServiceRowResult {
  const statuses = new Set(rows.map((row) => row.normalized.status));
  const status: ServiceRowStatus = statuses.size === 1 ? rows[0].normalized.status
    : statuses.has("INCOMPLETE") ? "INCOMPLETE"
      : statuses.has("ACTION_REQUIRED") ? "ACTION_REQUIRED" : "FAILED";
  const claimDetails = uniqueNonempty(rows.map((row) => row.normalized.result.claim_details));
  const errorMessages = uniqueNonempty(rows.map((row) => row.normalized.error_message));
  const category = rows.find((row) => row.normalized.status === status)?.normalized.error_category;

  return {
    client_row_ref: ref,
    status,
    result: {
      claim_status: statuses.size === 1 ? rows[0].normalized.result.claim_status
        : status === "INCOMPLETE" ? "" : "Failed",
      claim_details: claimDetails.join("\n"),
      detail_rows: rows.map((row) => row.detail),
    },
    error_category: status === "SUCCESS" ? null : category ?? (
      status === "NO_MATCH" ? "NO_MATCH"
        : status === "ACTION_REQUIRED" ? "MANUAL_ACTION_REQUIRED"
          : status === "INCOMPLETE" ? "INCOMPLETE" : "PORTAL_ERROR"
    ),
    error_message: errorMessages.join(" | ") || null,
  };
}

export async function normalizeIehpServiceWorkbook(
  buffer: Uint8Array,
  expectedRefs: string[],
  options: { requireStatusColumns?: boolean } = {},
): Promise<ServiceResultSummary> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(buffer) as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Output workbook has no worksheet.");
  const headers = new Map<string, number>();
  worksheet.getRow(1).eachCell((cell, number) => headers.set(cellText(cell), number));
  const refColumn = headers.get("Client Row Ref");
  if (!refColumn) throw new Error("Output workbook is missing Client Row Ref.");
  if ((options.requireStatusColumns ?? true) && (!headers.has("BotClaimStatusCheck") || !headers.has("BotClaimStatusCheckError"))) {
    throw new Error("Output workbook is missing claim status columns.");
  }
  const expected = new Set(expectedRefs);
  const rowsByRef = new Map<string, ParsedDetailRow[]>();
  for (let index = 2; index <= worksheet.rowCount; index += 1) {
    const row = worksheet.getRow(index);
    const ref = cellText(row.getCell(refColumn));
    if (!ref) continue;
    if (!expected.has(ref)) throw new Error(`Output workbook has an unexpected row reference: ${ref}.`);
    const read = (header: string) => {
      const column = headers.get(header);
      return column ? cellText(row.getCell(column)) : "";
    };
    const claimStatus = read("BotClaimStatusCheck");
    const errorMessage = read("BotClaimStatusCheckError");
    const claimDetails = read("BotClaimDetails");
    const { status } = classifyClaimCompletion("iehp", { BotClaimStatusCheck: claimStatus, BotClaimStatusCheckError: errorMessage });
    const errorCategory = status === "SUCCESS" ? null : status === "ACTION_REQUIRED" ? "MANUAL_ACTION_REQUIRED"
      : status === "FAILED" ? /^skipped$/i.test(claimStatus) ? "INVALID_INPUT" : "PORTAL_ERROR" : status;
    const normalized: ClaimServiceRowResult = {
      client_row_ref: ref,
      status,
      result: { claim_status: claimStatus, claim_details: claimDetails },
      error_category: errorCategory,
      error_message: errorMessage || null,
    };
    const detail: Record<string, string> = {};
    for (const [header, column] of headers) {
      if (!detailHeaders.has(header)) continue;
      const value = cellText(row.getCell(column));
      if (value) detail[header] = value;
    }
    const grouped = rowsByRef.get(ref) ?? [];
    grouped.push({ normalized, detail });
    rowsByRef.set(ref, grouped);
  }
  if ((options.requireStatusColumns ?? true) && rowsByRef.size !== expected.size) throw new Error(`Output workbook contains ${rowsByRef.size} of ${expected.size} expected claim rows.`);
  const rowResults = expectedRefs.map(ref => {
    const row = rowsByRef.has(ref) ? groupClaimRows(ref, rowsByRef.get(ref)!) : incompleteServiceResult(ref);
    return { ...row, result: claimStatusResultFields("iehp", row.result) };
  });
  return summarizeServiceResults(rowResults);
}
