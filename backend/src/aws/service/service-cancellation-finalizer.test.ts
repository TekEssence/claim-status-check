import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { finalizeCancelledServiceJob, finalizeStoppedServiceJob, type CancellationConfirmation, type StoppedWorkerTask } from "./service-cancellation-finalizer";
import { cancelServiceExecution } from "./service-cancellation";
import { publicationDatabase } from "./result-publication-test-helpers";
import { publishWorkerResultSnapshot, readWorkerServiceResultPage } from "./result-publication-store";
import { incompleteServiceResult, summarizeServiceResults } from "./result-summary";
import type { ServiceRowResult } from "./service-contract";
import type { WorkerResultManifest } from "./worker-result-contract";
import type { ServiceWorkbookArtifact } from "./iehp-snapshot";

type Job = Parameters<typeof finalizeCancelledServiceJob>[0];
const refs = ["A", "B", "C", "D"];
const stopped = { kind: "stopped", lastStatus: "STOPPED", taskArn: "task-1" } as const;
const crashed: StoppedWorkerTask = { lastStatus: "STOPPED", taskArn: "task-1", stopCode: "EssentialContainerExited",
  containers: [{ name: "worker", exitCode: 137, reason: "OutOfMemoryError" }] };
const clean: StoppedWorkerTask = { lastStatus: "STOPPED", taskArn: "task-1", containers: [{ name: "worker", exitCode: 0 }] };
const artifact: ServiceWorkbookArtifact = { bucket: "outputs", object_key: "job/output/claims.xlsx",
  artifact_type: "output_snapshot", filename: "claims.xlsx", size_bytes: 100, etag: null };
const success = (ref: string, amount = 0): ServiceRowResult => ({ client_row_ref: ref, status: "SUCCESS",
  result: { worker_result_version: 1, worker_outcome: "SUCCESS", detail_rows: [{ "Worker Outcome": "SUCCESS", amount }] },
  error_category: null, error_message: null });
function fixture(expected = refs, status: Job["status"] = "cancelling", unstarted = false) {
  const db = publicationDatabase(expected);
  const metadata = { serviceClaimRefs: expected, expectedRowCount: expected.length, ...(unstarted ? { serviceCancelledBeforeLaunch: true } : {}) };
  db.setJobState({ status, metadata });
  let recovered: ServiceRowResult[] = [];
  let recoveryArtifact: ServiceWorkbookArtifact | null = null;
  let bytes: Uint8Array | null = null;
  let recoveryError = false;
  let discovered: ServiceWorkbookArtifact[] = [];
  const calls = { snapshot: 0, workbook: 0, publish: 0, notify: 0 };
  const current = () => {
    const state = db.jobState(); const progress = db.progress();
    return { jobId: "job", portalId: "iehp", workflowId: state.workflow_id, clientSystem: state.client_system,
      status: state.status, ecsTaskArn: unstarted ? null : "task-1", outputBucket: "outputs", outputPrefix: "job/output",
      inputBucket: "inputs", claimFileName: "claims.xlsx", currentCompleted: progress?.completed ?? 0,
      totalRows: progress?.total ?? expected.length, metadata: { ...metadata, ...progress?.metadata, ...state.metadata },
      errorMessage: state.error_message ?? null,
      finishedAt: ["cancelled", "completed", "partial_success", "failed"].includes(state.status) ? "2026-11-15T00:00:00Z" : null } as Job;
  };
  const deps: NonNullable<Parameters<typeof finalizeCancelledServiceJob>[2]> = {
    find: async () => current(), refs: async () => { throw new Error("References should come from job metadata."); },
    snapshot: async () => {
      calls.snapshot++;
      if (recoveryError) throw new Error("S3 temporarily unavailable");
      const byRef = new Map(recovered.map(row => [row.client_row_ref, row]));
      return { expectedRefs: expected, artifact: recoveryArtifact, recorded: true,
        summary: summarizeServiceResults(expected.map(ref => byRef.get(ref) ?? incompleteServiceResult(ref))) };
    },
    artifacts: async () => [], workbook: async () => { calls.workbook++; return bytes; }, discover: async () => discovered,
    publish: async (job, expectedRefs, manifest, finalization) => {
      calls.publish++;
      return publishWorkerResultSnapshot(job.jobId, job.portalId, expectedRefs, manifest, db.pool, finalization ?? job.clientSystem!);
    },
    notify: async () => { calls.notify++; return 1; },
    notifyStopped: async () => { calls.notify++; return 1; },
  };
  return { db, calls, current, deps, finalize: (proof: CancellationConfirmation = stopped) => finalizeCancelledServiceJob(current(), proof, deps),
    finalizeStopped: (task = crashed) => finalizeStoppedServiceJob(current(), task, deps),
    recover: (rows: ServiceRowResult[]) => { recovered = rows; },
    workbook: (value: Uint8Array) => { bytes = value; recoveryArtifact = artifact; },
    orphanWorkbook: (value: Uint8Array) => { bytes = value; discovered = [artifact]; },
    failRecovery: (value: boolean) => { recoveryError = value; } };
}
async function publish(f: ReturnType<typeof fixture>, rows: ServiceRowResult[], expected = refs) {
  const manifest: WorkerResultManifest = { version: 1, producer: "claim-status-worker", job_id: "job", finalized: false, results: rows, artifact: null };
  await publishWorkerResultSnapshot("job", "iehp", expected, manifest, f.db.pool);
}

test("cancel before launch closes claims without reading inputs/output or starting a worker", async () => {
  const f = fixture(refs, "queued", true);
  let workerCommands = 0;
  const result = await cancelServiceExecution({ find: async () => f.current(),
    cancelBeforeLaunch: async () => {
      f.db.setJobState({ status: "cancelling" }); // Same launch-blocking transition as the repository.
      await f.finalize({ kind: "before-launch" }); return true;
    }, markCancelling: async () => false, requestWorkerCancel: async () => { workerCommands++; },
    reconcile: async () => f.current() });
  assert.deepEqual(result, { jobId: "job", status: "cancelled", terminal: true });
  assert.equal(workerCommands, 0);
  assert.equal(f.calls.snapshot, 0); assert.equal(f.calls.workbook, 0);
  assert.equal(f.db.stored().length, 4);
  assert.ok(f.db.stored().every(row => row.result.status === "FAILED" && row.result.error_category === "CANCELLED"));
  assert.equal(f.db.progress()?.completed, 4);
  assert.ok(f.db.jobState().metadata.serviceCancellationFinalizedAt);
});

for (const action of ["normal cancellation", "force stop", "cancel while waiting for OTP"]) {
  test(`${action}: preserve DB outcomes, recover saved JSON/workbook outcomes, and close only missing claims`, async () => {
    const f = fixture();
    await publish(f, [success("A", 0)]);
    const original = f.db.stored()[0];
    f.recover([success("A", 999), success("B", 10)]); // Already-published A cannot be overwritten.
    const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Output");
    sheet.addRow(["Client Row Ref", "Worker Outcome", "Claim Status - Paid Amount"]);
    sheet.addRow(["C", "SUCCESS", 0]); sheet.addRow(["C", "SUCCESS", 10]);
    f.workbook(new Uint8Array(await book.xlsx.writeBuffer()));
    const result = await f.finalize();
    assert.equal(result.status, "cancelled");
    assert.deepEqual(f.db.stored()[0], original);
    assert.deepEqual(f.db.stored().map(row => row.result.status), ["SUCCESS", "SUCCESS", "SUCCESS", "FAILED"]);
    assert.equal(f.db.stored()[2].result.result.detail_rows?.length, 2);
    assert.equal(f.db.stored()[3].result.error_category, "CANCELLED");
    const page = await readWorkerServiceResultPage("job", 1, 2, f.db.pool);
    assert.deepEqual([page.processed, page.pending, page.nextCursor, page.available], [4, 0, 3, 4]);
    assert.equal(page.nextCursor === page.available, false); // Final delivery must still drain the last page.
    const last = await readWorkerServiceResultPage("job", 3, 2, f.db.pool);
    assert.equal(last.nextCursor === last.available && last.pending === 0, true);
    assert.equal(page.summary.counts.success, 3); assert.equal(page.summary.counts.failed, 1);
  });
}

test("running/stopping or mismatched tasks cannot be finalized prematurely", async () => {
  const f = fixture();
  for (const proof of [{ ...stopped, lastStatus: "RUNNING" }, { ...stopped, lastStatus: "STOPPING" },
    { ...stopped, taskArn: "other-task" }, { kind: "before-launch" } as const]) {
    await assert.rejects(f.finalize(proof), /must be confirmed/);
  }
  assert.equal(f.calls.snapshot, 0); assert.equal(f.calls.publish, 0);
  assert.equal(f.db.jobState().status, "cancelling");
});

test("recover a workbook uploaded just before termination even when its JSON/artifact row was never saved", async () => {
  const f = fixture();
  const book = new ExcelJS.Workbook(); const output = book.addWorksheet("Output");
  output.addRow(["Client Row Ref", "Worker Outcome", "Claim Status - Paid Amount"]);
  output.addRow(["B", "SUCCESS", 0]);
  f.orphanWorkbook(new Uint8Array(await book.xlsx.writeBuffer()));
  await f.finalize();
  const outcomes = f.db.stored().map(row => [row.client_row_ref, row.result.status]);
  assert.deepEqual(outcomes, [["A", "FAILED"], ["B", "SUCCESS"], ["C", "FAILED"], ["D", "FAILED"]]);
  assert.equal(f.db.stored()[1].result.result["Claim Status - Paid Amount"], 0);
});

test("confirmed task absence still recovers saved output; only blocked launch skips recovery", async () => {
  const f = fixture(refs, "cancelling", true);
  f.db.setJobState({ metadata: { serviceCancellationTaskAbsent: true } });
  f.recover([success("B")]);
  await f.finalize({ kind: "task-absent" });
  assert.equal(f.calls.snapshot, 1);
  assert.equal(f.db.stored().find(row => row.client_row_ref === "B")?.result.status, "SUCCESS");
});

test("output discovery and workbook read failures cannot finalize delivery", async () => {
  for (const operation of ["discover", "workbook"] as const) {
    const f = fixture(); await publish(f, [success("A")]);
    f.orphanWorkbook(new Uint8Array());
    const deps = { ...f.deps, [operation]: async () => { throw new Error("Temporary S3 failure"); } };
    await assert.rejects(finalizeCancelledServiceJob(f.current(), stopped, deps), /reconciliation will retry/);
    assert.equal(f.db.stored().length, 1);
    assert.equal(f.db.jobState().status, "cancelling");
  }
});

test("recovery failures leave cancellation unfinished; DB failures roll back claims, counters and terminal status", async () => {
  const f = fixture(); await publish(f, [success("A")]);
  f.failRecovery(true);
  await assert.rejects(f.finalize(), /reconciliation will retry/);
  assert.equal(f.db.stored().length, 1); assert.equal(f.db.jobState().status, "cancelling");
  f.failRecovery(false); f.recover([success("B")]);
  f.db.failNextProgressWrite();
  await assert.rejects(f.finalize(), /reconciliation will retry/);
  assert.equal(f.db.stored().length, 1); assert.equal(f.db.progress()?.completed, 1);
  assert.equal(f.db.jobState().status, "cancelling");
  assert.equal(f.db.jobState().metadata.serviceCancellationFinalizedAt, undefined);
  await f.finalize();
  assert.equal(f.db.stored().length, 4); assert.equal(f.db.jobState().status, "cancelled");
});

test("repeated/concurrent cancellation and a lost commit reply never duplicate or replace outcomes", async () => {
  const f = fixture(); await publish(f, [success("A")]);
  f.db.loseNextCommitResponse();
  await assert.rejects(f.finalize(), /reconciliation will retry/);
  assert.equal(f.db.jobState().status, "cancelled");
  const saved = f.db.stored();
  await Promise.all([f.finalize(), f.finalize()]);
  assert.deepEqual(f.db.stored(), saved);
  assert.equal(new Set(saved.map(row => row.client_row_ref)).size, 4);
  await assert.rejects(publish(f, [success("B", 999)]), /already been finalized/);
  assert.deepEqual(f.db.stored(), saved);
});

test("legacy cancelled job with 147/290 published outcomes appends 143 closures without resetting its cursor", async () => {
  const expected = Array.from({ length: 290 }, (_, index) => `claim-${index}`);
  const f = fixture(expected, "cancelled");
  // Seed the exact historical shape without a cancellation-finalized marker.
  await publish(f, expected.slice(0, 147).map(ref => success(ref)), expected);
  const original = f.db.stored();
  await f.finalize({ kind: "already-cancelled" });
  assert.deepEqual(f.db.stored().slice(0, 147), original);
  const first = await readWorkerServiceResultPage("job", 147, 100, f.db.pool);
  assert.deepEqual([first.processed, first.pending, first.results.length, first.nextCursor], [290, 0, 100, 247]);
  const last = await readWorkerServiceResultPage("job", 247, 100, f.db.pool);
  assert.deepEqual([last.results.length, last.nextCursor, last.available], [43, 290, 290]);
  assert.ok(last.results.every(row => row.error_category === "CANCELLED"));
});

test("OOM stop preserves committed and recoverable results, closes only missing claims, and drains the same cursor", async () => {
  const f = fixture(refs, "running"); await publish(f, [success("A", 0)]);
  const original = f.db.stored()[0]; f.recover([success("A", 999), success("B")]);
  const job = await f.finalizeStopped();
  assert.equal(job.status, "partial_success");
  assert.match(job.errorMessage!, /OutOfMemoryError/);
  assert.deepEqual(f.db.stored()[0], original);
  assert.deepEqual(f.db.stored().map(row => row.result.error_category), [null, null, "TASK_FAILED", "TASK_FAILED"]);
  const page = await readWorkerServiceResultPage("job", 1, 100, f.db.pool);
  assert.deepEqual([page.processed, page.pending, page.nextCursor, page.results.length], [4, 0, 4, 3]);
  assert.deepEqual([page.summary.counts.success, page.summary.counts.failed], [2, 2]);
});

test("clean exit uses saved claim outcomes; zero exit alone cannot manufacture success", async () => {
  const all = fixture(refs, "running"); all.recover(refs.map(ref => success(ref)));
  assert.equal((await all.finalizeStopped(clean)).status, "completed");
  assert.equal(all.db.jobState().error_message, null);
  const partial = fixture(refs, "running"); partial.recover([success("A")]);
  assert.equal((await partial.finalizeStopped(clean)).status, "partial_success");
  assert.ok(partial.db.stored().slice(1).every(row => row.result.error_category === "OUTPUT_MISSING"));
  const failed = fixture(refs, "running");
  assert.equal((await failed.finalizeStopped()).status, "failed");
  assert.ok(failed.db.stored().every(row => row.result.error_category === "TASK_FAILED"));
  const afterOutput = fixture(refs, "running"); afterOutput.recover(refs.map(ref => success(ref)));
  assert.equal((await afterOutput.finalizeStopped()).status, "partial_success");
  assert.ok(afterOutput.db.stored().every(row => row.result.status === "SUCCESS"));
});

test("cancel and deadline requests determine the stop reason even if ECS reports a nonzero exit", async () => {
  const cancel = fixture();
  assert.equal((await cancel.finalizeStopped()).status, "cancelled");
  assert.ok(cancel.db.stored().every(row => row.result.error_category === "CANCELLED"));
  const deadline = fixture(refs, "running");
  deadline.db.setJobState({ metadata: { ...deadline.db.jobState().metadata, deadlineStopRequestedAt: "2026-11-15T00:00:00Z" } });
  assert.equal((await deadline.finalizeStopped()).status, "failed");
  assert.ok(deadline.db.stored().every(row => row.result.error_category === "DEADLINE_EXCEEDED"));
});

test("duplicate crash events, concurrent reconciliation and lost commit replies cannot change published outcomes", async () => {
  const f = fixture(refs, "running"); await publish(f, [success("A")]);
  f.db.loseNextCommitResponse();
  await assert.rejects(f.finalizeStopped(), /reconciliation will retry/);
  const saved = f.db.stored();
  await Promise.all([f.finalizeStopped(), f.finalizeStopped()]);
  assert.deepEqual(f.db.stored(), saved);
  await assert.rejects(publish(f, [success("B", 999)]), /already been finalized/);
  assert.equal(f.db.jobState().metadata.serviceTaskStopReason, "TASK_FAILED");
});

test("crash reconciliation rolls back a failed DB commit and retries temporary recovery failures", async () => {
  const f = fixture(refs, "running"); await publish(f, [success("A")]);
  f.failRecovery(true);
  await assert.rejects(f.finalizeStopped(), /reconciliation will retry/);
  assert.equal(f.db.jobState().status, "running");
  f.failRecovery(false); f.db.failNextProgressWrite();
  await assert.rejects(f.finalizeStopped(), /reconciliation will retry/);
  assert.equal(f.db.stored().length, 1); assert.equal(f.db.progress()?.completed, 1);
  assert.equal(f.db.jobState().metadata.serviceTaskFinalizedAt, undefined);
  await f.finalizeStopped();
  assert.equal(f.db.stored().length, 4); assert.equal(f.db.progress()?.completed, 4);
});

test("cancellation racing with crash reconciliation wins without recording incorrect crash failures", async () => {
  const f = fixture(refs, "running"); await publish(f, [success("A")]);
  await assert.rejects(finalizeStoppedServiceJob(f.current(), crashed, { ...f.deps, publish: async (...args) => {
    f.db.setJobState({ status: "cancelling" }); return f.deps.publish(...args);
  } }), /state changed/);
  assert.equal(f.db.stored().length, 1);
  await f.finalizeStopped();
  assert.ok(f.db.stored().slice(1).every(row => row.result.error_category === "CANCELLED"));
});

test("completed worker publication needs no S3 recovery; running and stale tasks cannot close results", async () => {
  const f = fixture(refs, "running");
  await publishWorkerResultSnapshot("job", "iehp", refs, { version: 1, producer: "claim-status-worker", job_id: "job",
    finalized: true, results: refs.map(ref => success(ref)), artifact: null }, f.db.pool);
  f.db.setJobState({ status: "completed" });
  const saved = f.db.stored(); f.failRecovery(true);
  assert.equal((await f.finalizeStopped(clean)).status, "completed");
  assert.equal(f.calls.snapshot, 0); assert.deepEqual(f.db.stored(), saved);
  for (const task of [{ ...crashed, lastStatus: "RUNNING" }, { ...crashed, taskArn: "other-task" }]) {
    await assert.rejects(f.finalizeStopped(task), /must be confirmed/);
  }
});
