import type { Pool } from "pg";
import type { ServiceResultSummary, ServiceRowResult } from "./service-contract";
import { planServiceResultPublications } from "./result-publication";
import { UNFINISHED_WORKER_PATTERN } from "./claim-completion";

/** Single-snapshot fixture helper. Production must persist the plan before paging. */
export function publishedResults(summary: ServiceResultSummary) {
  return planServiceResultPublications([], { expectedRefs: summary.row_results.map(row => row.client_row_ref), summary });
}

type Stored = { sequence: number; client_row_ref: string; result: ServiceRowResult };

/** Transaction/row-lock fake exercising the production SQL repository, not its publication policy. */
export function publicationDatabase(expectedRefs: string[] = []) {
  const jobs = new Map<string, Stored[]>();
  type JobState = { status: string; client_system: string; workflow_id: string; ecs_task_arn?: string | null; error_message?: string | null; metadata: Record<string, unknown> };
  const states = new Map<string, JobState>();
  const state = (id: string): JobState => states.get(id) ?? { status: "running", client_system: "AR_WORKFLOW", workflow_id: "claim-status", metadata: {} };
  type Progress = { completed: number; total: number; metadata: Record<string, unknown> };
  const progress = new Map<string, Progress>();
  const queries: string[] = [];
  let queue = Promise.resolve();
  let loseCommitResponse = false;
  let failProgress = false;
  const pool = { connect: async () => {
    let unlock: (() => void) | undefined;
    let jobId = "";
    let transaction: Stored[] = [];
    let transactionProgress: Progress | undefined;
    let transactionState: JobState;
    return {
      query: async (sql: string, args: unknown[] = []) => {
        queries.push(sql);
        if (sql === "BEGIN") return { rows: [], rowCount: 0 };
        if (sql.includes("FOR UPDATE")) {
          const previous = queue;
          queue = new Promise<void>(resolve => { unlock = resolve; });
          await previous;
          jobId = String(args[0]);
          transaction = structuredClone(jobs.get(jobId) ?? []);
          transactionProgress = structuredClone(progress.get(jobId));
          transactionState = structuredClone(state(jobId));
          return { rows: [{ job_id: jobId, ...transactionState }], rowCount: 1 };
        }
        if (sql.startsWith("SELECT sequence")) return { rows: transaction.map(row => ({
          sequence: row.sequence, client_row_ref: row.client_row_ref, status: row.result.status, error_category: row.result.error_category,
          unfinished_success: row.result.status === "SUCCESS" && row.result.result.detail_rows?.some(detail => {
            const field = (args[1] as string[]).find(key => Object.hasOwn(detail, key));
            return field && new RegExp(UNFINISHED_WORKER_PATTERN, "i").test(String(detail[field] ?? ""));
          }),
        })), rowCount: transaction.length };
        if (sql.startsWith("INSERT")) {
          const additions = JSON.parse(String(args[1])) as Stored[];
          if (additions.some(row => transaction.some(old => old.client_row_ref === row.client_row_ref || old.sequence === row.sequence))) throw new Error("unique publication constraint violated");
          transaction.push(...additions);
          return { rows: [], rowCount: additions.length };
        }
        if (sql.startsWith("SELECT result")) return { rows: transaction.filter(row => row.sequence > Number(args[1]) && row.sequence <= Number(args[2])).map(row => ({ result: structuredClone(row.result) })), rowCount: 0 };
        if (sql.startsWith("UPDATE workflow_jobs")) {
          if (failProgress) { failProgress = false; throw new Error("Progress write failed"); }
          transactionProgress = { completed: Number(args[1]), total: Number(args[2]), metadata: {
            ...transactionState.metadata, serviceClaimRefs: expectedRefs, expectedRowCount: expectedRefs.length, workerResultState: JSON.parse(String(args[3])),
            ...(args[4] ? { serviceCancellationFinalizedAt: transactionState.metadata.serviceCancellationFinalizedAt ?? "2026-11-15T00:00:00Z" } : {}),
            ...(args[5] ? { serviceTaskFinalizedAt: transactionState.metadata.serviceTaskFinalizedAt ?? "2026-11-15T00:00:00Z", serviceTaskStopReason: args[8] } : {}),
          } };
          transactionState.metadata = transactionProgress.metadata;
          if (args[5]) {
            transactionState.status = String(args[5]); transactionState.error_message = args[6] as string | null;
          }
          transactionState.ecs_task_arn ??= args[7] as string | null;
          return { rows: [], rowCount: 1 };
        }
        if (sql === "COMMIT") {
          jobs.set(jobId, structuredClone(transaction));
          if (transactionProgress) progress.set(jobId, structuredClone(transactionProgress));
          if (transactionState) states.set(jobId, structuredClone(transactionState));
          unlock?.(); unlock = undefined;
          if (loseCommitResponse) { loseCommitResponse = false; throw Object.assign(new Error("Commit response lost"), { code: "ECONNRESET" }); }
          return { rows: [], rowCount: 0 };
        }
        if (sql === "ROLLBACK") { unlock?.(); unlock = undefined; return { rows: [], rowCount: 0 }; }
        throw new Error("Unexpected publication SQL");
      },
      release: () => { unlock?.(); },
    };
  }, query: async (sql: string, args: unknown[]) => {
    queries.push(sql);
    if (!sql.startsWith("SELECT j.metadata")) throw new Error("Unexpected read SQL");
    const id = String(args[0]);
    const saved = progress.get(id);
    const metadata = saved?.metadata ?? { serviceClaimRefs: expectedRefs, expectedRowCount: expectedRefs.length };
    const fast = (metadata.workerResultState as { countsVersion?: number } | undefined)?.countsVersion === 1;
    const publications = jobs.get(id) ?? [];
    return { rows: [{ workflow_id: state(id).workflow_id, portal_id: "iehp", metadata, current_completed: saved?.completed ?? 0, total_rows: saved?.total ?? expectedRefs.length,
      publications: structuredClone(fast ? publications.filter(row => row.sequence > Number(args[1])).slice(0, Number(args[2])) : publications) }], rowCount: 1 };
  } } as unknown as Pick<Pool, "connect" | "query">;
  return { pool, queries, stored: (id = "job") => structuredClone(jobs.get(id) ?? []),
    jobState: (id = "job") => structuredClone(state(id)),
    setJobState: (update: Partial<JobState>, id = "job") => { states.set(id, { ...state(id), ...update }); },
    progress: (id = "job") => structuredClone(progress.get(id)),
    failNextProgressWrite: () => { failProgress = true; }, loseNextCommitResponse: () => { loseCommitResponse = true; } };
}
