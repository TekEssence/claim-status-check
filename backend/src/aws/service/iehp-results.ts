import ExcelJS from "exceljs";

export type ServiceRowStatus = "SUCCESS" | "FAILED" | "NO_MATCH" | "ACTION_REQUIRED" | "INCOMPLETE";
export type ServiceOutcome = "SUCCESS" | "PARTIAL_SUCCESS" | "FAILED";
export type ServiceRowResult = {
  client_row_ref: string;
  status: ServiceRowStatus;
  result: { claim_status: string; claim_details: string; detail_rows?: Array<Record<string, string>> };
  error_category: string | null;
  error_message: string | null;
};
export type ServiceResultSummary = {
  outcome: ServiceOutcome;
  counts: { total: number; success: number; no_match: number; failed: number; action_required: number; incomplete: number };
  row_results: ServiceRowResult[];
  finalized_count: number;
};

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  return String(value).trim();
}

const detailHeaders = new Set([
  "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotReferRA",
  "SummaryBlockDOS", "SummaryBlockDate", "Check Number", "Bot CIN", "Received Date", "Check Date",
  "Bot Plan Type", "Billed Amount", "Other related payment details", "RA Proc Code", "RA Check Amount",
  "RA Amount Billed", "RA Amount Allowed", "RA Copay", "RA Coins", "RA Deduct Amount", "RA Net Paid",
  "RA Status", "RA Reason", "RA Denial Reason", "Final Status",
]);

type ParsedDetailRow = { normalized: ServiceRowResult; detail: Record<string, string> };

function uniqueNonempty(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function groupClaimRows(ref: string, rows: ParsedDetailRow[]): ServiceRowResult {
  if (rows.length === 1) return rows[0].normalized;

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
  worksheet.getRow(1).eachCell((cell, number) => headers.set(cellText(cell.value), number));
  const refColumn = headers.get("Client Row Ref");
  if (!refColumn) throw new Error("Output workbook is missing Client Row Ref.");
  if ((options.requireStatusColumns ?? true) && (!headers.has("BotClaimStatusCheck") || !headers.has("BotClaimStatusCheckError"))) {
    throw new Error("Output workbook is missing claim status columns.");
  }
  const expected = new Set(expectedRefs);
  const rowsByRef = new Map<string, ParsedDetailRow[]>();
  for (let index = 2; index <= worksheet.rowCount; index += 1) {
    const row = worksheet.getRow(index);
    const ref = cellText(row.getCell(refColumn).value);
    if (!ref) continue;
    if (!expected.has(ref)) throw new Error(`Output workbook has an unexpected row reference: ${ref}.`);
    const read = (header: string) => {
      const column = headers.get(header);
      return column ? cellText(row.getCell(column).value) : "";
    };
    const claimStatus = read("BotClaimStatusCheck");
    const errorMessage = read("BotClaimStatusCheckError");
    const claimDetails = read("BotClaimDetails");
    let status: ServiceRowStatus;
    let errorCategory: string | null = null;
    if (/^success$/i.test(claimStatus)) {
      status = "SUCCESS";
    } else if (/no matching|no claim found|not found for/i.test(errorMessage)) {
      status = "NO_MATCH";
      errorCategory = "NO_MATCH";
    } else if (/otp|mfa|captcha|verification required|action required/i.test(errorMessage)) {
      status = "ACTION_REQUIRED";
      errorCategory = "MANUAL_ACTION_REQUIRED";
    } else if (/^failed$|^skipped$/i.test(claimStatus)) {
      status = "FAILED";
      errorCategory = /^skipped$/i.test(claimStatus) ? "INVALID_INPUT" : "PORTAL_ERROR";
    } else {
      status = "INCOMPLETE";
      errorCategory = "INCOMPLETE";
    }
    const normalized: ServiceRowResult = {
      client_row_ref: ref,
      status,
      result: { claim_status: claimStatus, claim_details: claimDetails },
      error_category: errorCategory,
      error_message: errorMessage || null,
    };
    const detail: Record<string, string> = {};
    for (const [header, column] of headers) {
      if (!detailHeaders.has(header)) continue;
      const value = cellText(row.getCell(column).value);
      if (value) detail[header] = value;
    }
    const grouped = rowsByRef.get(ref) ?? [];
    grouped.push({ normalized, detail });
    rowsByRef.set(ref, grouped);
  }
  if (rowsByRef.size !== expected.size) throw new Error(`Output workbook contains ${rowsByRef.size} of ${expected.size} expected claim rows.`);
  const rowResults = expectedRefs.map((ref) => groupClaimRows(ref, rowsByRef.get(ref)!));
  const firstIncomplete = rowResults.findIndex((row) => row.status === "INCOMPLETE");
  const finalizedCount = firstIncomplete < 0 ? rowResults.length : firstIncomplete;
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
    finalized_count: finalizedCount,
  };
}

export function pageServiceResults(summary: ServiceResultSummary | null, cursor: number, limit: number, terminal: boolean) {
  const available = summary ? terminal ? summary.row_results.length : summary.finalized_count : 0;
  const nextCursor = Math.min(available, cursor + limit);
  return { available, nextCursor, results: summary?.row_results.slice(cursor, nextCursor) ?? [] };
}

export const pageIehpServiceResults = pageServiceResults;
