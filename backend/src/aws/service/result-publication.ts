import type { ServiceResultSummary, ServiceRowResult } from "./service-contract";
import { classifyClaimCompletion } from "./claim-completion";
import { validateWorkerResult } from "./worker-result-contract";

export class ServicePublicationError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

export type PublicationEntry = { sequence: number; clientRowRef: string; errorCategory: string | null };
export type PublicationInput = {
  expectedRefs: string[];
  summary: ServiceResultSummary | null;
  terminalStatus?: string | null;
  terminalFailure?: { category: string; message: string };
  /** Claim Status validates worker outcomes and never synthesizes terminal rows. */
  claimStatusPortal?: string;
};

/** Check the frozen payload itself, not the current (possibly stale) snapshot. */
export function validateClaimPublication(portal: string, row: ServiceRowResult): void {
  if (row.result.worker_result_version === 1) {
    try { validateWorkerResult(row); } catch { throw new ServicePublicationError(503, "Worker result contract is invalid."); }
    return;
  }
  const details = row.result.detail_rows;
  if (row.status !== "SUCCESS" || !details?.length) return;
  const outcomes = details.map(detail => classifyClaimCompletion(portal, detail).status);
  if (outcomes.some(status => status === "INCOMPLETE" || status === "FAILED" || status === "ACTION_REQUIRED")
    || outcomes.every(status => status === "NO_MATCH")) {
    throw new ServicePublicationError(503, "A Claim Status success conflicts with its worker details. An audited correction is required for recorded results; no results were delivered or cursors reset.");
  }
}

/**
 * This plan must run under a per-job database lock. Workbook order is not a
 * cursor: late completions would shift previously delivered pages. Assign each
 * finalized client_row_ref one durable sequence, appending only unseen refs.
 * Initial assignment follows submission order for legacy numeric-cursor
 * compatibility; later earlier-row completions append instead of being inserted.
 */
export function planServiceResultPublications(existing: PublicationEntry[], input: PublicationInput): ServiceRowResult[] {
  const expected = new Set(input.expectedRefs);
  if (!expected.size || expected.size !== input.expectedRefs.length || input.expectedRefs.some(ref => !ref)) throw new ServicePublicationError(503, "Submitted claim references are invalid.");
  if (input.terminalStatus && !["completed", "partial_success", "failed", "cancelled"].includes(input.terminalStatus)) throw new ServicePublicationError(503, "Cannot finalize pending claims for a nonterminal job.");
  const recorded = new Set<string>();
  for (const [index, row] of existing.entries()) {
    if (row.sequence !== index + 1 || !expected.has(row.clientRowRef) || recorded.has(row.clientRowRef)) throw new ServicePublicationError(503, "Recorded result publication is inconsistent.");
    recorded.add(row.clientRowRef);
  }
  const current = new Map<string, ServiceRowResult>();
  for (const row of input.summary?.row_results ?? []) {
    if (!expected.has(row.client_row_ref) || current.has(row.client_row_ref)) throw new ServicePublicationError(503, "Normalized result references are invalid.");
    current.set(row.client_row_ref, row);
  }
  return input.expectedRefs.flatMap(ref => {
    if (recorded.has(ref)) return [];
    const row = current.get(ref);
    if (row && row.status !== "INCOMPLETE") {
      const portal = input.claimStatusPortal;
      if (portal) validateClaimPublication(portal, row);
      return [structuredClone(row)];
    }
    // Claim Status outcomes belong to the worker, including cancellation and
    // missing output. A Lambda/job terminal status cannot finalize a claim.
    if (!input.terminalStatus || input.claimStatusPortal) return [];
    // A stopped job cannot produce a late result. Account explicitly for every
    // remaining reference without pretending portal automation succeeded.
    return [{
      client_row_ref: ref, status: "FAILED" as const,
      result: row ? structuredClone(row.result) : {},
      error_category: input.terminalFailure?.category ?? (input.terminalStatus === "cancelled" ? "CANCELLED" : "OUTPUT_MISSING"),
      error_message: input.terminalFailure?.message ?? "The job ended without a finalized result for this claim.",
    }];
  });
}

/** Only a durable publication sequence may be sliced; never a live summary. */
export function pageServiceResults(published: readonly ServiceRowResult[], cursor: number, limit: number) {
  validateServiceResultPage(cursor, limit);
  if (cursor > published.length) throw new ServicePublicationError(503, "Result cursor exceeds the recorded publication count.");
  const nextCursor = Math.min(published.length, cursor + limit);
  return { available: published.length, nextCursor, results: published.slice(cursor, nextCursor) };
}

export function validateServiceResultPage(cursor: number, limit: number) {
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ServicePublicationError(400, "Invalid result cursor or limit.");
}
