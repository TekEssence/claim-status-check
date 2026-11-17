import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { getServiceJobResult, getServiceJobResultBatch } from "./service-jobs";
import { readWorkerServiceResultBatch } from "../service/result-publication-store";
import type { ApiEvent } from "../runtime/http";

const token = "batch-test-service-token-at-least-32-characters";
type Request = { job_id: string; cursor?: string; limit?: number };
function event(jobs: Request[]): ApiEvent {
  return { pathParameters: { jobId: "batch" }, headers: { "X-Client-System": "AR_WORKFLOW", Authorization: `Bearer ${token}` },
    queryStringParameters: { jobs: JSON.stringify(jobs) } };
}
function row(id: string, count = 3, options: { status?: string; owner?: string; detailBytes?: number; metadataBytes?: number; skipped?: boolean } = {}) {
  const refs = Array.from({ length: count }, (_, index) => `${id}-${index}`);
  const outcome = options.skipped ? "SKIPPED" : options.status === "failed" ? "FAILED" : "SUCCESS";
  const metadata = { serviceClaimRefs: refs, expectedRowCount: count, accountLabel: "account",
    workerResultState: { countsVersion: 1, counts: { total: count, success: outcome === "SUCCESS" ? count : 0,
      failed: outcome === "FAILED" ? count : 0, skipped: outcome === "SKIPPED" ? count : 0, no_match: 0, action_required: 0, incomplete: 0 },
      unsupported: options.skipped ? count : 0,
      artifact: { filename: "claims.xlsx", bucket: "out", object_key: id, size_bytes: 12, etag: null, artifact_type: "output_snapshot" } } };
  return { metadata, portal_id: "iehp", current_completed: count, total_rows: count,
    job: { job_id: id, client_system: options.owner ?? "AR_WORKFLOW", client_execution_id: `run-${id}`,
    current_completed: count, total_rows: count,
    workflow_id: "claim-status", portal_id: "iehp", status: options.status ?? "running", metadata, error_message: options.status === "failed" ? "Portal unavailable" : null },
    challenge: options.status === "waiting_otp" ? { createdAt: "2026-11-14T00:00:00Z", payload: {
      type: "provider_options", inputName: "provider_selection", providerStage: "care", careProviders: [{ id: "provider-1" }],
      label: "Choose provider", message: "x".repeat(options.metadataBytes ?? 10), timeoutMs: 300000 } } : null,
    publications: refs.map((ref, index) => ({ sequence: index + 1, client_row_ref: ref, result: {
      client_row_ref: ref, status: outcome, error_category: options.skipped ? "UNSUPPORTED_PAYER" : null, error_message: null,
      result: { worker_result_version: 1, worker_outcome: outcome, detail_rows: [
        { "Worker Outcome": outcome, amount: 0, detail: "文".repeat(options.detailBytes ?? 1) },
        { "Worker Outcome": outcome, amount: 10 },
      ] },
    } })) };
}
function fixture(rows: ReturnType<typeof row>[]) {
  const calls: { sql: string; args: unknown[] }[] = [];
  const pool = { query: async (sql: string, args: unknown[]) => {
    calls.push({ sql, args });
    const client = String(args[0]);
    const requests = JSON.parse(String(args[1])) as { job_id: string; after_cursor: number; page_limit: number }[];
    return { rows: rows.filter(item => item.job.client_system === client && requests.some(request => request.job_id === item.job.job_id)).map(item => {
      const request = requests.find(request => request.job_id === item.job.job_id)!;
      const fast = item.metadata.workerResultState.countsVersion === 1;
      return { ...item, publications: fast ? item.publications.filter(publication => publication.sequence > request.after_cursor).slice(0, request.page_limit) : item.publications };
    }) };
  } } as unknown as Pick<Pool, "query">;
  return { calls, read: (client: string, requests: Parameters<typeof readWorkerServiceResultBatch>[1]) => readWorkerServiceResultBatch(client, requests, pool) };
}

test("existing results route authenticates batch mode before querying", async () => {
  const response = await getServiceJobResult({ ...event([{ job_id: "A" }]), headers: { Authorization: "Bearer invalid" } });
  assert.ok([401, 503].includes(response.statusCode));
});

test("batch API: independent cursors, partial errors, bounded results, OTP and byte limits", async t => {
  const previous = process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON;
  process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON = JSON.stringify({ AR_WORKFLOW: token });
  try {
    await t.test("configured authentication rejects an invalid token in both modes", async () => {
      const input = { ...event([{ job_id: "A" }]), headers: { "X-Client-System": "AR_WORKFLOW", Authorization: "Bearer invalid" } };
      assert.equal((await getServiceJobResult(input)).statusCode, 401);
      assert.equal((await getServiceJobResult({ ...input, pathParameters: { jobId: "A" } })).statusCode, 401);
    });
    await t.test("one owned-job query, independent cursors, stable replay and whole multi-detail outcomes", async () => {
      const db = fixture([row("A"), row("B", 4, { status: "completed" })]);
      const input = event([{ job_id: "A", cursor: "0", limit: 1 }, { job_id: "B", cursor: "2", limit: 2 }]);
      const response = await getServiceJobResultBatch(input, db.read);
      assert.equal(response.statusCode, 200);
      const { jobs } = JSON.parse(response.body);
      assert.deepEqual(jobs.A.results.map((result: { client_row_ref: string }) => result.client_row_ref), ["A-0"]);
      assert.deepEqual(jobs.B.results.map((result: { client_row_ref: string }) => result.client_row_ref), ["B-2", "B-3"]);
      assert.deepEqual([jobs.A.next_cursor, jobs.B.next_cursor, jobs.B.final], ["1", "4", true]);
      assert.equal(jobs.A.results[0].result.detail_rows.length, 2);
      assert.equal(jobs.A.results[0].result.detail_rows[0].amount, 0);
      assert.deepEqual([jobs.A.success, jobs.A.failed, jobs.A.skipped], [3, 0, 0]);
      assert.equal(db.calls.length, 1);
      assert.match(db.calls[0].sql, /j.client_system = \$1/);
      assert.equal(db.calls[0].args[0], "AR_WORKFLOW");
      assert.deepEqual(JSON.parse(String(db.calls[0].args[1])), [
        { job_id: "A", after_cursor: 0, page_limit: 1 }, { job_id: "B", after_cursor: 2, page_limit: 2 },
      ]);
      assert.equal((await getServiceJobResultBatch(input, db.read)).body, response.body);
    });
    await t.test("missing, unauthorized, corrupt, bad-cursor and failed jobs are isolated", async () => {
      const corrupt = row("corrupt"); corrupt.publications[0].result.client_row_ref = "unexpected";
      const db = fixture([row("valid"), row("foreign", 3, { owner: "OTHER" }), corrupt, row("failed", 3, { status: "failed" })]);
      const response = await getServiceJobResultBatch(event([
        { job_id: "valid" }, { job_id: "missing" }, { job_id: "foreign" }, { job_id: "corrupt" },
        { job_id: "failed" }, { job_id: "bad-cursor", cursor: "-1" },
      ]), db.read);
      const { jobs } = JSON.parse(response.body);
      assert.deepEqual([jobs.valid.http_status, jobs.missing.http_status, jobs.foreign.http_status, jobs.corrupt.http_status, jobs.failed.http_status, jobs["bad-cursor"].http_status], [200, 404, 404, 503, 200, 400]);
      assert.deepEqual(jobs.missing, jobs.foreign);
      assert.equal(jobs.failed.status, "FAILED");
      assert.equal(jobs.failed.error, "Portal unavailable");
      assert.equal(jobs.corrupt.next_cursor, "0");
    });
    await t.test("request limits and invalid page limits are checked before database access", async () => {
      const db = fixture([]);
      for (const jobs of [[], Array.from({ length: 11 }, (_, i) => ({ job_id: `J${i}` })), [{ job_id: "A" }, { job_id: "A" }]]) {
        assert.equal((await getServiceJobResultBatch(event(jobs), db.read)).statusCode, 400);
      }
      for (const limit of [0, 201, 1.5]) {
        assert.equal(JSON.parse((await getServiceJobResultBatch(event([{ job_id: "A", limit }]), db.read)).body).jobs.A.http_status, 400);
      }
      for (const jobs of ["{invalid", "x".repeat(8193)]) {
        assert.equal((await getServiceJobResultBatch({ ...event([]), queryStringParameters: { jobs } }, db.read)).statusCode, 400);
      }
      assert.equal(db.calls.length, 0);
    });
    await t.test("invalid cursor objects and unfinished historical rows outside the page cannot affect other jobs", async () => {
      const historical = row("historical");
      Reflect.deleteProperty(historical.metadata.workerResultState, "countsVersion");
      Object.assign(historical.publications[0].result.result.detail_rows[0], { BotClaimStatusCheck: "Not processed. Job stopped." });
      const input = event([{ job_id: "A" }, { job_id: "historical", cursor: "1", limit: 1 },
        { job_id: "invalid", cursor: { valueOf: null, toString: null } as unknown as string }]);
      const { jobs } = JSON.parse((await getServiceJobResultBatch(input, fixture([row("A"), historical]).read)).body);
      assert.deepEqual([jobs.A.http_status, jobs.historical.http_status, jobs.invalid.http_status], [200, 503, 400]);
    });
    await t.test("unsupported workflows are isolated and a shared database outage returns 503", async () => {
      const eligibility = row("eligibility"); eligibility.job.workflow_id = "eligibility-verification";
      const { jobs } = JSON.parse((await getServiceJobResultBatch(event([{ job_id: "eligibility" }, { job_id: "A" }]), fixture([eligibility, row("A")]).read)).body);
      assert.deepEqual([jobs.eligibility.http_status, jobs.A.http_status], [422, 200]);
      const pool = { query: async () => { throw new Error("Database unavailable"); } } as unknown as Pick<Pool, "query">;
      const response = await getServiceJobResultBatch(event([{ job_id: "A" }]), (client, requests) => readWorkerServiceResultBatch(client, requests, pool));
      assert.equal(response.statusCode, 503);
    });
    await t.test("all ten large jobs receive a fair independent page within 500 total outcomes", async () => {
      const rows = Array.from({ length: 10 }, (_, i) => row(`J${i}`, 60));
      const response = await getServiceJobResultBatch(event(rows.map(item => ({ job_id: item.job.job_id, limit: 200 }))), fixture(rows).read);
      const jobs = Object.values(JSON.parse(response.body).jobs) as { results: unknown[]; processed: number; next_cursor: string; final: boolean }[];
      assert.ok(jobs.every(job => job.results.length === 50 && job.processed === 60 && job.next_cursor === "50" && !job.final));
      assert.equal(jobs.reduce((sum, job) => sum + job.results.length, 0), 500);
    });
    await t.test("saved skipped counters and inconsistent counts are independent of page size and other jobs", async () => {
      const skipped = row("skipped", 20, { skipped: true, status: "failed" });
      const corrupt = row("bad-counts"); corrupt.metadata.workerResultState.counts.success++;
      const { jobs } = JSON.parse((await getServiceJobResultBatch(event([
        { job_id: "skipped", cursor: "10", limit: 1 }, { job_id: "bad-counts" }, { job_id: "valid" },
      ]), fixture([skipped, corrupt, row("valid")]).read)).body);
      assert.equal(jobs.skipped.results[0].status, "SKIPPED");
      assert.deepEqual([jobs.skipped.skipped, jobs.skipped.failed, jobs.skipped.processed, jobs.skipped.unsupported, jobs.skipped.next_cursor], [20, 0, 20, 20, "11"]);
      assert.deepEqual([jobs["bad-counts"].http_status, jobs.valid.http_status], [503, 200]);
    });
    await t.test("cancelled job drains the remaining 143 outcomes before delivery becomes final", async () => {
      const cancelled = row("cancelled", 290, { status: "cancelled" });
      for (const publication of cancelled.publications.slice(147)) {
        Object.assign(publication.result, { status: "FAILED", error_category: "CANCELLED", error_message: "Job cancelled." });
        publication.result.result.worker_outcome = "FAILED";
        publication.result.result.detail_rows = [];
      }
      cancelled.metadata.workerResultState.counts.success = 147;
      cancelled.metadata.workerResultState.counts.failed = 143;
      const db = fixture([cancelled]);
      const first = JSON.parse((await getServiceJobResultBatch(event([{ job_id: "cancelled", cursor: "147", limit: 100 }]), db.read)).body).jobs.cancelled;
      assert.deepEqual([first.status, first.processed, first.pending, first.results.length, first.next_cursor, first.final],
        ["CANCELLED", 290, 0, 100, "247", false]);
      assert.equal(first.error_category, "CANCELLED");
      const last = JSON.parse((await getServiceJobResultBatch(event([{ job_id: "cancelled", cursor: first.next_cursor, limit: 100 }]), db.read)).body).jobs.cancelled;
      assert.deepEqual([last.results.length, last.next_cursor, last.final], [43, "290", true]);
      assert.ok(last.results.every((result: { error_category: string }) => result.error_category === "CANCELLED"));
      assert.equal((await getServiceJobResultBatch(event([{ job_id: "cancelled", cursor: "247", limit: 100 }]), db.read)).body,
        JSON.stringify({ jobs: { cancelled: last } }));
    });
    await t.test("crash and deadline failures preserve previous results and become final only after remaining pages drain", async () => {
      for (const reason of ["TASK_FAILED", "DEADLINE_EXCEEDED"]) {
        const stopped = row("stopped", 4, { status: "partial_success" });
        stopped.job.error_message = reason === "TASK_FAILED" ? "AWS worker task stopped: OutOfMemoryError" : "Execution deadline exceeded.";
        for (const publication of stopped.publications.slice(2)) {
          publication.result.status = "FAILED"; publication.result.result.worker_outcome = "FAILED";
          publication.result.error_category = reason;
          publication.result.result.detail_rows = [];
        }
        stopped.metadata.workerResultState.counts.success = 2; stopped.metadata.workerResultState.counts.failed = 2;
        const db = fixture([stopped]);
        const first = JSON.parse((await getServiceJobResultBatch(event([{ job_id: "stopped", cursor: "2", limit: 1 }]), db.read)).body).jobs.stopped;
        assert.deepEqual([first.status, first.error_category, first.processed, first.pending, first.next_cursor, first.final],
          ["PARTIAL_SUCCESS", reason, 4, 0, "3", false]);
        assert.equal(first.results[0].error_category, reason);
        const last = JSON.parse((await getServiceJobResultBatch(event([{ job_id: "stopped", cursor: "3", limit: 1 }]), db.read)).body).jobs.stopped;
        assert.deepEqual([last.next_cursor, last.final], ["4", true]);
      }
    });
    await t.test("UTF-8 byte trimming never skips omitted claims or starves another job", async () => {
      const db = fixture([row("large", 5, { detailBytes: 300000 }), row("small", 3, { status: "completed" })]);
      const response = await getServiceJobResultBatch(event([{ job_id: "large" }, { job_id: "small" }]), db.read);
      const { jobs } = JSON.parse(response.body);
      assert.ok(Buffer.byteLength(response.body) <= 4 * 1024 * 1024);
      assert.equal(jobs.large.results.length, 2);
      assert.equal(jobs.large.next_cursor, "2");
      assert.equal(jobs.small.final, true);
      const next = JSON.parse((await getServiceJobResultBatch(event([{ job_id: "large", cursor: "2" }, { job_id: "small", cursor: "3" }]), db.read)).body);
      assert.equal(next.jobs.large.results[0].client_row_ref, "large-2");
    });
    await t.test("oversized whole claims and action metadata fail only that job without advancing", async () => {
      for (const large of [row("large", 1, { detailBytes: 800000 }), row("large", 1, { status: "waiting_otp", metadataBytes: 2200000 })]) {
        const response = await getServiceJobResultBatch(event([{ job_id: "large" }, { job_id: "small" }]), fixture([large, row("small")]).read);
        const { jobs } = JSON.parse(response.body);
        assert.deepEqual([jobs.large.http_status, jobs.large.next_cursor, jobs.small.http_status], [413, "0", 200]);
        assert.ok(Buffer.byteLength(response.body) <= 4 * 1024 * 1024);
      }
    });
    await t.test("provider-selection and OTP responses keep their existing fields", async () => {
      const otp = row("otp", 1, { status: "waiting_otp" });
      otp.challenge!.payload.type = "otp_required"; otp.challenge!.payload.inputName = "iehp_otp";
      otp.challenge!.payload.timeoutMs = 360000;
      const provider = row("provider", 1, { status: "waiting_otp" });
      for (const waiting of [otp, provider]) {
        waiting.publications = [];
        waiting.current_completed = waiting.job.current_completed = 0;
        waiting.metadata.workerResultState.counts.success = 0;
        waiting.metadata.workerResultState.counts.incomplete = 1;
      }
      const { jobs } = JSON.parse((await getServiceJobResultBatch(event([{ job_id: "provider" }, { job_id: "otp" }]),
        fixture([provider, otp]).read)).body);
      assert.equal(jobs.provider.action_required.type, "PROVIDER_SELECTION_REQUIRED");
      assert.deepEqual(jobs.provider.action_required.options, [{ id: "provider-1" }]);
      assert.equal(jobs.otp.action_required.type, "OTP_REQUIRED");
      assert.equal(jobs.otp.action_required.input_name, "iehp_otp");
      assert.equal(jobs.otp.action_required.expires_at, "2026-11-14T00:06:00.000Z");
      assert.deepEqual([jobs.otp.processed, jobs.otp.pending, jobs.otp.action_required_count], [0, 1, 0]);
    });
  } finally {
    if (previous === undefined) delete process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON;
    else process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON = previous;
  }
});
