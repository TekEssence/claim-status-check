import type { ServiceResultSummary, ServiceRowResult } from "./service-contract";

export function incompleteServiceResult(ref: string): ServiceRowResult {
  return { client_row_ref: ref, status: "INCOMPLETE", result: { claim_status: "", claim_details: "" }, error_category: "INCOMPLETE", error_message: null };
}

/** Finalized means a complete claim result anywhere, never a submitted-order prefix. */
export function summarizeServiceResults(rows: ServiceRowResult[]): ServiceResultSummary {
  const counts = {
    total: rows.length,
    success: rows.filter(row => row.status === "SUCCESS").length,
    no_match: rows.filter(row => row.status === "NO_MATCH").length,
    failed: rows.filter(row => row.status === "FAILED").length,
    skipped: rows.filter(row => row.status === "SKIPPED").length,
    action_required: rows.filter(row => row.status === "ACTION_REQUIRED").length,
    incomplete: rows.filter(row => row.status === "INCOMPLETE").length,
  };
  return {
    outcome: counts.success === counts.total ? "SUCCESS" : counts.success > 0 ? "PARTIAL_SUCCESS" : "FAILED",
    counts, row_results: rows, finalized_count: counts.total - counts.incomplete,
  };
}
