import { getPool, runDbWithRetry } from "@/db";
import type { Pool, PoolClient } from "pg";
import type { ServiceRowResult, ServiceRowStatus, ServiceResultSummary } from "./service-contract";
import { pageServiceResults, planServiceResultPublications, ServicePublicationError, validateServiceResultPage, validateClaimPublication, type PublicationEntry, type PublicationInput } from "./result-publication";
import { claimWorkerStatusFields, UNFINISHED_WORKER_PATTERN } from "./claim-completion";
import { validateWorkerManifest, workerManifestSummary, type WorkerResultManifest } from "./worker-result-contract";
import { incompleteServiceResult, summarizeServiceResults } from "./result-summary";
import type { getWorkflowJobById, getLatestWorkflowInputRequest } from "../runtime/workflow-db";

type PublicationRequest = PublicationInput & {
  jobId: string; cursor: number; limit: number;
  workerState?: Pick<WorkerResultManifest, "artifact" | "finalized">;
  finalization?: WorkerResultFinalization;
};
export type WorkerResultFinalization = {
  clientSystem: string; taskArn?: string; exitCode?: number;
  reason: "CANCELLED" | "TASK_FAILED" | "DEADLINE_EXCEEDED" | "OUTPUT_MISSING";
  errorMessage: string;
};
type SqlPool = Pick<Pool, "connect">;
type WorkerResultState = Pick<WorkerResultManifest, "artifact" | "finalized"> & {
  countsVersion?: number; counts?: ServiceResultSummary["counts"]; unsupported?: number;
};
type WorkerResultReadRow = {
  metadata: { serviceClaimRefs?: unknown; expectedRowCount?: unknown; workerResultState?: WorkerResultState };
  current_completed?: number; total_rows?: number;
  workflow_id?: string; portal_id: string; publications: Array<{ sequence: number; client_row_ref: string; result: ServiceRowResult }>;
};
export type ServiceResultPageRequest = { job_id: string; cursor: number; limit: number };

/**
 * Integrated workers share this append-only ledger. The job row
 * lock serializes sequence allocation; unique keys enforce one publication per
 * reference and sequence. Payloads are frozen at first finalization, so retries
 * cannot return a different result or lose it to a temporarily older snapshot.
 */
export async function recordServiceResultPage(input: PublicationRequest, pool: SqlPool) {
  validateServiceResultPage(input.cursor, input.limit);
  const client: PoolClient = await pool.connect();
  try {
    await client.query("BEGIN");
    const job = await client.query<{ job_id: string; status: string; client_system: string | null; workflow_id: string; ecs_task_arn: string | null;
      metadata: { serviceCancellationFinalizedAt?: unknown; serviceTaskFinalizedAt?: unknown } }>(
      "SELECT job_id, status, client_system, workflow_id, ecs_task_arn, metadata FROM workflow_jobs WHERE job_id = $1 FOR UPDATE", [input.jobId]);
    if (!job.rowCount) throw new ServicePublicationError(404, "Job not found.");
    const locked = job.rows[0];
    const finalization = input.finalization;
    const cancelling = finalization?.reason === "CANCELLED";
    if (finalization && (locked.client_system !== finalization.clientSystem || !["claim-status", "eligibility-verification"].includes(locked.workflow_id)
      || cancelling !== ["cancelling", "cancelled"].includes(locked.status)
      || (finalization.taskArn && locked.ecs_task_arn && locked.ecs_task_arn !== finalization.taskArn))) {
      throw new ServicePublicationError(409, "Job state changed during task-stop finalization; retry reconciliation.");
    }
    if (input.workerState && !finalization && (locked.metadata?.serviceCancellationFinalizedAt || locked.metadata?.serviceTaskFinalizedAt)) {
      throw new ServicePublicationError(409, "Job results have already been finalized after task stop.");
    }
    const rows = await client.query<{ sequence: number; client_row_ref: string; status: ServiceRowStatus; error_category: string | null; unfinished_success: boolean }>(
      `SELECT sequence, client_row_ref, result->>'status' AS status, result->>'error_category' AS error_category,
        CASE WHEN result->>'status' = 'SUCCESS' THEN EXISTS (
          SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(result #> '{result,detail_rows}') = 'array'
            THEN result #> '{result,detail_rows}' ELSE '[]'::jsonb END) detail
          WHERE (SELECT detail ->> field FROM unnest($2::text[]) WITH ORDINALITY AS fields(field, position)
            WHERE detail ? field ORDER BY position LIMIT 1) ~* $3
        ) ELSE false END AS unfinished_success
        FROM workflow_service_results WHERE job_id = $1 ORDER BY sequence`,
      [input.jobId, input.claimStatusPortal ? claimWorkerStatusFields(input.claimStatusPortal) : [], UNFINISHED_WORKER_PATTERN],
    );
    if (rows.rows.some(row => row.unfinished_success)) {
      throw new ServicePublicationError(503, "Previously recorded Claim Status results contain unfinished worker rows. An audited correction is required; no results were delivered or cursors reset.");
    }
    const existing: PublicationEntry[] = rows.rows.map(row => ({ sequence: row.sequence, clientRowRef: row.client_row_ref, errorCategory: row.error_category }));
    const additions = planServiceResultPublications(existing, input);
    if (additions.length) {
      const values = additions.map((result, index) => ({ sequence: existing.length + index + 1, client_row_ref: result.client_row_ref, result }));
      await client.query(
        "INSERT INTO workflow_service_results (job_id, sequence, client_row_ref, result) SELECT $1, item.sequence, item.client_row_ref, item.result FROM jsonb_to_recordset($2::jsonb) AS item(sequence integer, client_row_ref text, result jsonb)",
        [input.jobId, JSON.stringify(values)],
      );
    }
    const available = existing.length + additions.length;
    if (input.cursor > available) throw new ServicePublicationError(503, "Result cursor exceeds the recorded publication count.");
    const nextCursor = Math.min(available, input.cursor + input.limit);
    const page = await client.query<{ result: ServiceRowResult }>(
      "SELECT result FROM workflow_service_results WHERE job_id = $1 AND sequence > $2 AND sequence <= $3 ORDER BY sequence", [input.jobId, input.cursor, nextCursor],
    );
    if (input.claimStatusPortal) {
      for (const row of page.rows) validateClaimPublication(input.claimStatusPortal, row.result);
    }
    const unsupported = existing.filter(row => row.errorCategory === "UNSUPPORTED_PAYER").length
      + additions.filter(row => row.error_category === "UNSUPPORTED_PAYER").length;
    if (input.workerState) {
      // Tally the immutable ledger and newly inserted outcomes, not a possibly
      // stale worker snapshot. Retries cannot double-count or regress totals.
      const counts = summarizeServiceResults([...rows.rows.map(row => ({
        client_row_ref: row.client_row_ref, status: row.status, result: {}, error_category: row.error_category, error_message: null,
      })), ...additions]).counts;
      counts.total = input.expectedRefs.length;
      counts.incomplete = counts.total - available;
      if (counts.success + counts.failed + counts.no_match + counts.skipped + counts.action_required !== available) {
        throw new ServicePublicationError(503, "Recorded claim outcomes are inconsistent.");
      }
      const terminalStatus = !finalization ? null : cancelling ? "cancelled"
        : counts.success === counts.total && finalization.exitCode === 0 && finalization.reason === "OUTPUT_MISSING" ? "completed"
          : counts.success > 0 ? "partial_success" : "failed";
      await client.query(
        `UPDATE workflow_jobs SET current_completed = $2, total_rows = $3,
          metadata = metadata || jsonb_build_object('workerResultState', $4::jsonb)
            || CASE WHEN $5::boolean THEN jsonb_build_object('serviceCancellationFinalizedAt',
              COALESCE(metadata->'serviceCancellationFinalizedAt', to_jsonb(now()))) ELSE '{}'::jsonb END
            || CASE WHEN $6::text IS NOT NULL THEN jsonb_build_object('serviceTaskFinalizedAt',
              COALESCE(metadata->'serviceTaskFinalizedAt', to_jsonb(now())), 'serviceTaskStopReason', $9::text) ELSE '{}'::jsonb END,
          status = COALESCE($6::text, status),
          error_message = CASE WHEN $6::text IS NOT NULL THEN $7::text ELSE error_message END,
          finished_at = CASE WHEN $6::text IS NOT NULL THEN COALESCE(finished_at, now()) ELSE finished_at END,
          ecs_task_arn = COALESCE(ecs_task_arn, $8::text),
          updated_at = now()
          WHERE job_id = $1`,
        [input.jobId, available, input.expectedRefs.length, JSON.stringify({ ...input.workerState, countsVersion: 1, counts, unsupported }), Boolean(cancelling),
          terminalStatus, terminalStatus === "completed" ? null : finalization?.errorMessage ?? null, finalization?.taskArn ?? null, finalization?.reason ?? null],
      );
    }
    await client.query("COMMIT");
    return { available, nextCursor, results: page.rows.map(row => row.result), processed: available, pending: input.expectedRefs.length - available, unsupported };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") throw new ServicePublicationError(503, "Service result publication database migration 0008 has not been applied.");
    throw error;
  } finally {
    client.release();
  }
}

export function publishServiceResultPage(input: PublicationRequest, pool?: SqlPool) {
  return pool ? recordServiceResultPage(input, pool) : runDbWithRetry(() => recordServiceResultPage(input, getPool()));
}

/** Claim outcomes and the completed counter become visible in the same commit. */
export function publishWorkerResultSnapshot(jobId: string, portalId: string, expectedRefs: string[], manifest: WorkerResultManifest, pool?: SqlPool, finalization?: string | WorkerResultFinalization) {
  validateWorkerManifest(manifest, jobId, expectedRefs);
  const publish = () => recordServiceResultPage({
    jobId, claimStatusPortal: portalId, expectedRefs, summary: workerManifestSummary(manifest, expectedRefs),
    cursor: 0, limit: 1, workerState: { artifact: manifest.artifact, finalized: manifest.finalized },
    finalization: typeof finalization === "string" ? { clientSystem: finalization, reason: "CANCELLED", errorMessage: "Job cancelled." } : finalization,
  }, pool ?? getPool());
  return pool ? publish() : runDbWithRetry(publish);
}

/** Read-only integrated result polling. Neither S3 nor a publication write is needed. */
export async function readWorkerServiceResultPage(jobId: string, cursor: number, limit: number, pool?: Pick<Pool, "query">) {
  validateServiceResultPage(cursor, limit);
  const read = () => (pool ?? getPool()).query<WorkerResultReadRow>(
    `SELECT j.metadata, j.portal_id, j.current_completed, j.total_rows, j.workflow_id,
      COALESCE(jsonb_agg(jsonb_build_object('sequence', r.sequence, 'client_row_ref', r.client_row_ref, 'result', r.result)
        ORDER BY r.sequence) FILTER (WHERE r.sequence IS NOT NULL), '[]'::jsonb) AS publications
      FROM workflow_jobs j LEFT JOIN LATERAL (
        SELECT sequence, client_row_ref, result FROM workflow_service_results
        WHERE job_id = j.job_id AND sequence > CASE WHEN j.metadata #>> '{workerResultState,countsVersion}' = '1' THEN $2::bigint ELSE 0 END
        ORDER BY sequence LIMIT CASE WHEN j.metadata #>> '{workerResultState,countsVersion}' = '1' THEN $3::integer ELSE NULL END
      ) r ON true WHERE j.job_id = $1 GROUP BY j.job_id`, [jobId, cursor, limit],
  );
  const data = await (pool ? read() : runDbWithRetry(read)).catch(error => {
    if (error?.code === "42P01") throw new ServicePublicationError(503, "Service result publication database migration 0008 has not been applied.");
    throw error;
  });
  const job = data.rows[0];
  if (!job) throw new ServicePublicationError(404, "Job not found.");
  return workerResultPage(job, cursor, limit);
}

/** One read snapshot for all owned jobs, their claim outcomes and active input requests. */
export async function readWorkerServiceResultBatch(clientSystem: string, requests: ServiceResultPageRequest[], pool?: Pick<Pool, "query">) {
  type Row = WorkerResultReadRow & { job: Record<string, unknown>; challenge: Awaited<ReturnType<typeof getLatestWorkflowInputRequest>> | null };
  const read = () => (pool ?? getPool()).query<Row>(
    `SELECT j.metadata, j.portal_id, j.current_completed, j.total_rows, to_jsonb(j) AS job,
      COALESCE(jsonb_agg(jsonb_build_object('sequence', r.sequence, 'client_row_ref', r.client_row_ref, 'result', r.result)
        ORDER BY r.sequence) FILTER (WHERE r.sequence IS NOT NULL), '[]'::jsonb) AS publications,
      (SELECT jsonb_build_object('payload', e.payload, 'createdAt', e.created_at) FROM workflow_job_events e
        WHERE e.job_id = j.job_id AND e.event_type = 'input_request' AND j.status = 'waiting_otp'
        ORDER BY e.id DESC LIMIT 1) AS challenge
      FROM jsonb_to_recordset($2::jsonb) AS requested(job_id text, after_cursor bigint, page_limit integer)
      JOIN workflow_jobs j ON j.job_id = requested.job_id LEFT JOIN LATERAL (
        SELECT sequence, client_row_ref, result FROM workflow_service_results
        WHERE job_id = j.job_id AND sequence > CASE WHEN j.metadata #>> '{workerResultState,countsVersion}' = '1' THEN requested.after_cursor ELSE 0 END
        ORDER BY sequence LIMIT CASE WHEN j.metadata #>> '{workerResultState,countsVersion}' = '1' THEN requested.page_limit ELSE NULL END
      ) r ON true
      WHERE j.client_system = $1 GROUP BY j.job_id`,
    [clientSystem, JSON.stringify(requests.map(request => ({ job_id: request.job_id, after_cursor: request.cursor, page_limit: request.limit })))],
  );
  const data = await (pool ? read() : runDbWithRetry(read)).catch(() => {
    throw new ServicePublicationError(503, "Batch results are unavailable; retry this poll.");
  });
  const byId = new Map(data.rows.map(row => [row.job.job_id, row]));
  return requests.map(request => {
    try {
      const row = byId.get(request.job_id);
      if (!row || row.job.client_system !== clientSystem) throw new ServicePublicationError(404, "Job not found.");
      if (row.job.workflow_id !== "claim-status") throw new ServicePublicationError(422, "Batch results support CLAIM_STATUS jobs only.");
      const job = Object.fromEntries(Object.entries(row.job).map(([key, value]) =>
        [key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()), value])) as NonNullable<Awaited<ReturnType<typeof getWorkflowJobById>>>;
      return { jobId: request.job_id, job, stored: workerResultPage(row, request.cursor, request.limit), challenge: row.challenge };
    } catch (error) { return { jobId: request.job_id, error }; }
  });
}

function workerResultPage(job: WorkerResultReadRow, cursor: number, limit: number) {
  validateServiceResultPage(cursor, limit);
  const refs = job.metadata.serviceClaimRefs;
  if (!Array.isArray(refs) || !refs.length || refs.length !== job.metadata.expectedRowCount
    || refs.some(ref => typeof ref !== "string" || !ref) || new Set(refs).size !== refs.length) {
    throw new ServicePublicationError(503, "Submitted claim references are unavailable; retry this poll.");
  }
  const expectedRefs = refs as string[];
  if (cursor > expectedRefs.length) throw new ServicePublicationError(400, "cursor exceeds the submitted claim count.");
  const publications = job.publications;
  const state = job.metadata.workerResultState;
  const claimStatusPortal = !job.workflow_id || job.workflow_id === "claim-status" ? job.portal_id : undefined;
  const saved = state?.countsVersion === 1 ? state.counts : undefined;
  if (state?.countsVersion === 1) {
    if (!saved || !Object.values(saved).every(value => Number.isSafeInteger(value) && value >= 0)
      || saved.total !== expectedRefs.length || job.total_rows !== saved.total
      || saved.success + saved.failed + saved.no_match + saved.skipped + saved.action_required !== job.current_completed
      || saved.incomplete !== saved.total - job.current_completed!
      || !Number.isSafeInteger(state.unsupported) || state.unsupported! < 0 || state.unsupported! > job.current_completed!) {
      throw new ServicePublicationError(503, "Saved claim outcome counts are inconsistent; retry this poll.");
    }
    if (cursor > job.current_completed!) throw new ServicePublicationError(503, "Result cursor exceeds the recorded publication count.");
    if (publications.length !== Math.min(limit, job.current_completed! - cursor)
      || publications.some((row, index) => row.sequence !== cursor + index + 1 || !expectedRefs.includes(row.client_row_ref))) {
      throw new ServicePublicationError(503, "Recorded result publication is inconsistent.");
    }
  } else {
    // Historical jobs without saved counts keep their existing read-only path.
    planServiceResultPublications(publications.map(row => ({ sequence: row.sequence, clientRowRef: row.client_row_ref, errorCategory: row.result.error_category })),
      { expectedRefs, summary: null, claimStatusPortal });
  }
  const results = publications.map(row => {
    if (row.result.client_row_ref !== row.client_row_ref || row.result.status === "INCOMPLETE") {
      throw new ServicePublicationError(503, "Recorded result publication is inconsistent.");
    }
    const fields = claimStatusPortal ? claimWorkerStatusFields(claimStatusPortal) : [];
    if (row.result.status === "SUCCESS" && row.result.result.detail_rows?.some(detail => {
      const field = fields.find(key => Object.hasOwn(detail, key));
      return field !== undefined && new RegExp(UNFINISHED_WORKER_PATTERN, "i").test(String(detail[field] ?? ""));
    })) throw new ServicePublicationError(503, "Previously recorded Claim Status results contain unfinished worker rows. An audited correction is required; no results were delivered or cursors reset.");
    if (claimStatusPortal) validateClaimPublication(claimStatusPortal, row.result);
    return row.result;
  });
  if (saved) {
    const processed = job.current_completed!;
    const summary: ServiceResultSummary = { counts: saved, finalized_count: processed, row_results: results,
      outcome: saved.success === saved.total ? "SUCCESS" : saved.success > 0 ? "PARTIAL_SUCCESS" : "FAILED" };
    return { expectedRefs, summary, artifact: state!.artifact, available: processed, processed,
      pending: saved.incomplete, unsupported: state!.unsupported!, results,
      nextCursor: publications.at(-1)?.sequence ?? cursor };
  }
  const byRef = new Map(results.map(row => [row.client_row_ref, row]));
  const summary = summarizeServiceResults(expectedRefs.map(ref => byRef.get(ref) ?? incompleteServiceResult(ref)));
  return {
    expectedRefs, summary, artifact: job.metadata.workerResultState?.artifact ?? null,
    ...pageServiceResults(results, cursor, limit), processed: results.length, pending: expectedRefs.length - results.length,
    unsupported: results.filter(row => row.error_category === "UNSUPPORTED_PAYER").length,
  };
}
