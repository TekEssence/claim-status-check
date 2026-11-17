import type { ServiceRowResult, ServiceResultSummary } from "./service-contract";
import type { ServiceWorkbookArtifact } from "./iehp-snapshot";
import { incompleteServiceResult, summarizeServiceResults } from "./result-summary";
import { isWorkerOutcome, WORKER_OUTCOME_COLUMN } from "../../workflows/claim-status/worker-outcome";

export type WorkerResultManifest = {
  version: 1;
  producer: "claim-status-worker";
  job_id: string;
  finalized: boolean;
  results: ServiceRowResult[];
  artifact: ServiceWorkbookArtifact | null;
};

export function workerResultManifestKey(outputPrefix: string | null): string {
  if (!outputPrefix) throw new Error("Worker result output prefix is missing.");
  return `${outputPrefix}/worker-results.v1.json`;
}

/** No workbook interpretation or status inference is permitted at this boundary. */
export function validateWorkerResult(row: ServiceRowResult): void {
  if (!row || typeof row.client_row_ref !== "string" || !row.client_row_ref
    || !isWorkerOutcome(row.status) || row.status === "INCOMPLETE"
    || row.result?.worker_result_version !== 1 || row.result?.worker_outcome !== row.status
    || !Array.isArray(row.result.detail_rows)
    || !(row.error_category === null || typeof row.error_category === "string")
    || !(row.error_message === null || typeof row.error_message === "string")) {
    throw new Error("Worker result contract is invalid.");
  }
  if (row.result.detail_rows.some(detail => !detail || typeof detail !== "object" || Array.isArray(detail))) throw new Error("Worker detail rows are invalid.");
  if (row.status === "SUCCESS" && (!row.result.detail_rows.length
    || !row.result.detail_rows.some(detail => detail[WORKER_OUTCOME_COLUMN] === "SUCCESS")
    || row.result.detail_rows.some(detail => !["SUCCESS", "NO_MATCH"].includes(String(detail[WORKER_OUTCOME_COLUMN]))))) {
    throw new Error("Worker success is missing explicit completed detail outcomes.");
  }
}

export function validateWorkerManifest(value: unknown, jobId: string, expectedRefs: string[]): WorkerResultManifest {
  const manifest = value as WorkerResultManifest | null;
  if (!manifest || manifest.version !== 1 || manifest.producer !== "claim-status-worker"
    || manifest.job_id !== jobId || typeof manifest.finalized !== "boolean" || !Array.isArray(manifest.results)) {
    throw new Error("Worker result manifest is invalid.");
  }
  const expected = new Set(expectedRefs);
  if (!expected.size || expected.size !== expectedRefs.length || expectedRefs.some(ref => typeof ref !== "string" || !ref)) throw new Error("Submitted claim references are invalid.");
  const seen = new Set<string>();
  for (const row of manifest.results) {
    validateWorkerResult(row);
    if (!expected.has(row.client_row_ref) || seen.has(row.client_row_ref)) throw new Error("Worker result references are invalid.");
    seen.add(row.client_row_ref);
  }
  if (manifest.finalized && seen.size !== expected.size) throw new Error("Final worker results are incomplete.");
  return manifest;
}

export function workerManifestSummary(manifest: WorkerResultManifest, expectedRefs: string[]): ServiceResultSummary {
  const completed = new Map(manifest.results.map(row => [row.client_row_ref, row]));
  return summarizeServiceResults(expectedRefs.map(ref => completed.get(ref) ?? incompleteServiceResult(ref)));
}
