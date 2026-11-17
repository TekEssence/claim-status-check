import test from "node:test";
import assert from "node:assert/strict";
import { publishWorkerResultSnapshot, readWorkerServiceResultPage, recordServiceResultPage } from "./result-publication-store";
import { publicationDatabase } from "./result-publication-test-helpers";
import { createClaimResultPublisher } from "../worker/claim-result-publisher";
import type { WorkerResultManifest } from "./worker-result-contract";
import type { ServiceRowStatus, ServiceResultSummary } from "./service-contract";
import { workerManifestSummary } from "./worker-result-contract";
import type { Pool } from "pg";

const refs = ["A", "B", "C", "D"];
const artifact = { bucket: "outputs", object_key: "claims.xlsx", artifact_type: "output_snapshot" as const,
  filename: "claims.xlsx", size_bytes: 100, etag: null };
function manifest(completed: string[], finalized = false): WorkerResultManifest {
  return { job_id: "job", producer: "claim-status-worker", version: 1, finalized, artifact,
    results: completed.map(ref => ({ client_row_ref: ref, status: "SUCCESS", error_category: null, error_message: null,
      result: { worker_result_version: 1, worker_outcome: "SUCCESS", detail_rows: [
        { "Worker Outcome": "SUCCESS", "Claim Status - Paid Amount": 0 },
        { "Worker Outcome": "SUCCESS", "Claim Status - Paid Amount": 10 },
      ] } })) };
}
const savedCounts = (db: ReturnType<typeof publicationDatabase>) =>
  (db.progress()!.metadata.workerResultState as { counts: ServiceResultSummary["counts"] }).counts;

test("worker commits grouped claim outcomes and matching progress before any API poll", async () => {
  const db = publicationDatabase(refs);
  await publishWorkerResultSnapshot("job", "iehp", refs, manifest(["A", "C", "D"]), db.pool);
  assert.equal(db.stored().length, 3);
  assert.equal(db.progress()?.completed, 3);
  assert.equal(db.progress()?.total, 4);
  assert.deepEqual(savedCounts(db), { total: 4, success: 3, no_match: 0, failed: 0, skipped: 0, action_required: 0, incomplete: 1 });
  assert.ok(db.queries.findIndex(sql => sql.startsWith("INSERT")) < db.queries.findIndex(sql => sql.startsWith("UPDATE")));
  assert.ok(db.queries.findIndex(sql => sql.startsWith("UPDATE")) < db.queries.indexOf("COMMIT"));
  const beforeRead = db.queries.length;
  const page = await readWorkerServiceResultPage("job", 0, 2, db.pool);
  assert.deepEqual(page.results.map(row => row.client_row_ref), ["A", "C"]);
  assert.equal(page.results[1].result.detail_rows?.length, 2);
  assert.equal(page.results[0].result.detail_rows?.[0]["Claim Status - Paid Amount"], 0);
  assert.deepEqual([page.processed, page.pending, page.nextCursor], [3, 1, 2]);
  assert.deepEqual(page.artifact, artifact);
  assert.equal(db.queries.length - beforeRead, 1);
  assert.match(db.queries.at(-1)!, /^SELECT/);
  assert.deepEqual(await readWorkerServiceResultPage("job", 0, 2, db.pool), page);
  await publishWorkerResultSnapshot("job", "iehp", refs, manifest(["A", "B", "C", "D"], true), db.pool);
  assert.deepEqual((await readWorkerServiceResultPage("job", 2, 2, db.pool)).results.map(row => row.client_row_ref), ["D", "B"]);
  assert.deepEqual(db.stored().map(row => row.sequence), [1, 2, 3, 4]);
});

test("progress failure rolls back outcomes and leaves the publisher's committed snapshot unchanged", async () => {
  const db = publicationDatabase(refs);
  const publisher = createClaimResultPublisher({ jobId: "job", expectedRefs: refs,
    save: async value => { await publishWorkerResultSnapshot("job", "iehp", refs, value, db.pool); } });
  await publisher.initialize();
  db.failNextProgressWrite();
  await assert.rejects(publisher.finish("CANCELLED"), /Progress write failed/);
  assert.deepEqual(db.stored(), []);
  assert.equal(db.progress()?.completed, 0);
  assert.equal(savedCounts(db).failed, 0);
  assert.equal(publisher.getSnapshot().results.length, 0);
  assert.ok(db.queries.includes("ROLLBACK"));
  await publisher.finish("CANCELLED");
  assert.equal(db.progress()?.completed, 4);
  assert.equal(savedCounts(db).failed, 4);
  assert.equal(db.stored().length, 4);
  assert.ok(db.stored().every(row => row.result.error_category === "CANCELLED"));
});

test("lost commit replies, concurrent writes and stale retries cannot duplicate or regress progress", async () => {
  const db = publicationDatabase(refs);
  db.loseNextCommitResponse();
  await assert.rejects(publishWorkerResultSnapshot("job", "iehp", refs, manifest(["A"]), db.pool), /Commit response lost/);
  assert.equal(db.progress()?.completed, 1);
  await Promise.all([manifest(["A"]), manifest(["A", "C"]), manifest(["A", "C", "D"])].map(value =>
    publishWorkerResultSnapshot("job", "iehp", refs, value, db.pool)));
  await publishWorkerResultSnapshot("job", "iehp", refs, manifest(["A"]), db.pool);
  assert.equal(db.stored().length, 3);
  assert.equal(db.progress()?.completed, 3);
  assert.equal(savedCounts(db).success, 3);
  assert.equal(new Set(db.stored().map(row => row.client_row_ref)).size, 3);
});

test("mixed outcome counts and unsupported subset are saved once and cannot regress on a stale retry", async () => {
  const db = publicationDatabase(refs);
  const value = manifest(refs, true);
  const statuses: ServiceRowStatus[] = ["SUCCESS", "NO_MATCH", "SKIPPED", "FAILED"];
  value.results.forEach((row, index) => {
    row.status = statuses[index]; row.result.worker_outcome = statuses[index];
    row.result.detail_rows!.forEach(detail => { detail["Worker Outcome"] = statuses[index]; });
    if (row.status === "SKIPPED") row.error_category = "UNSUPPORTED_PAYER";
  });
  await publishWorkerResultSnapshot("job", "iehp", refs, value, db.pool);
  const expected = { total: 4, success: 1, no_match: 1, failed: 1, skipped: 1, action_required: 0, incomplete: 0 };
  assert.deepEqual(savedCounts(db), expected);
  await publishWorkerResultSnapshot("job", "iehp", refs, manifest(["A"]), db.pool);
  assert.deepEqual(savedCounts(db), expected);
  const page = await readWorkerServiceResultPage("job", 2, 1, db.pool);
  assert.equal(page.results[0].status, "SKIPPED");
  assert.equal(page.unsupported, 1);
  assert.equal(page.processed, 4);
  assert.deepEqual(page.summary.counts, expected);
});

test("saved counters let a small cursor page report a large job's totals without reading its history", async () => {
  const many = Array.from({ length: 1000 }, (_, index) => `claim-${index}`);
  const db = publicationDatabase(many);
  await publishWorkerResultSnapshot("job", "iehp", many, manifest(many), db.pool);
  const before = db.queries.length;
  const page = await readWorkerServiceResultPage("job", 500, 2, db.pool);
  assert.deepEqual(page.results.map(row => row.client_row_ref), ["claim-500", "claim-501"]);
  assert.deepEqual([page.processed, page.summary.counts.success, page.nextCursor], [1000, 1000, 502]);
  assert.equal(db.queries.length - before, 1);
  assert.match(db.queries.at(-1)!, /LEFT JOIN LATERAL/);
  assert.match(db.queries.at(-1)!, /ORDER BY sequence LIMIT CASE/);
});

test("polling before worker publication is read-only and preserves an empty cursor", async () => {
  const db = publicationDatabase(refs);
  const page = await readWorkerServiceResultPage("job", 0, 100, db.pool);
  assert.deepEqual([page.processed, page.pending, page.nextCursor], [0, 4, 0]);
  assert.deepEqual(page.results, []);
  assert.ok(db.queries.every(sql => sql.startsWith("SELECT")));
  await assert.rejects(readWorkerServiceResultPage("job", -1, 100, db.pool));
  await assert.rejects(readWorkerServiceResultPage("job", 0, 201, db.pool));
});

test("read-only polls retain the existing protection against frozen unfinished successes", async () => {
  const db = publicationDatabase(refs);
  const bad = manifest(["A"]);
  bad.results[0].result.detail_rows![0].BotClaimStatusCheck = "Not processed. Job stopped.";
  // Legacy publication without portal validation can contain this historical corruption.
  await recordServiceResultPage({ jobId: "job", expectedRefs: refs, summary: workerManifestSummary(bad, refs), cursor: 0, limit: 100 }, db.pool);
  await assert.rejects(readWorkerServiceResultPage("job", 0, 100, db.pool), /unfinished worker rows/);
  await assert.rejects(readWorkerServiceResultPage("job", 1, 100, db.pool), /unfinished worker rows/);
});

test("a missing ledger migration remains a retryable poll error", async () => {
  const pool = { query: async () => { throw Object.assign(new Error("Relation missing"), { code: "42P01" }); } } as unknown as Pick<Pool, "query">;
  await assert.rejects(readWorkerServiceResultPage("job", 0, 100, pool), error =>
    error instanceof Error && "statusCode" in error && error.statusCode === 503 && /0008/.test(error.message));
});
