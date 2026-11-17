import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import Module from "node:module";
import { getScrapeJob } from "../../jobs/job-store";
import { ELIGIBILITY_SERVICE_PORTALS, eligibilityServiceOutputFilenames, eligibilityServiceProject } from "./eligibility-portals";
import type { AutomationContext } from "../../workflows/types";
import { buildWaystarOutputWorkbook } from "../../workflows/eligibility-verification/portals/waystar/output";
import { createEligibilityPartialOutput } from "../../workflows/eligibility-verification/partial-output";
import type { EligibilityResult } from "../../workflows/eligibility-verification/types";
import { normalizeEligibilityServiceWorkbook } from "./eligibility-results";
import { publicationDatabase } from "./result-publication-test-helpers";
import { publishServiceResultPage, readWorkerServiceResultPage } from "./result-publication-store";
import { finalizeCancelledServiceJob, finalizeStoppedServiceJob } from "./service-cancellation-finalizer";
import type { ServiceWorkbookArtifact } from "./iehp-snapshot";

const refs = ["A", "B", "C", "D"];
const artifact: ServiceWorkbookArtifact = { bucket: "outputs", object_key: "job/output/eligibility.xlsx",
  artifact_type: "output_snapshot", filename: "medrevenue-availity-eligibility-output.xlsx", size_bytes: 1, etag: null };
async function inputFile() {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Input");
  sheet.addRow(["Client Row Ref", "Primary Insurance Name", "Patient Name", "Member ID", "DOB", "DOS"]);
  for (const ref of refs) sheet.addRow([ref, "Molina", `Patient ${ref}`, ref, "01/01/2000", "01/01/2026"]);
  return new File([new Uint8Array(await book.xlsx.writeBuffer())], "input.xlsx");
}
const result = (rowIndex: number): EligibilityResult => ({ rowIndex, payerId: "molina", coverageStatus: "active",
  planStatus: "Active", benefits: [], address: "original address", metadata: {
    fullPayerResponse: { subscriberInformation: { address: "payer address" } }, medRevenueOutputServiceType: "Health Benefit Plan Coverage",
  } });
async function workbook(results: number[], errors = new Map<number, string>()) {
  return buildWaystarOutputWorkbook({ inputFile: await inputFile(), projectId: "medrevenue", rows: new Map(),
    results: new Map(results.map(index => [index, result(index)])), errors });
}
function database() {
  const db = publicationDatabase(refs);
  db.setJobState({ workflow_id: "eligibility-verification", ecs_task_arn: "task-1",
    metadata: { serviceClaimRefs: refs, expectedRowCount: refs.length } });
  return db;
}
async function publish(db: ReturnType<typeof database>, bytes: Uint8Array, jobId = "job") {
  const summary = await normalizeEligibilityServiceWorkbook(bytes, refs, { requireStatusColumns: false, unfinishedAsPending: true });
  return publishServiceResultPage({ jobId, expectedRefs: refs, summary, cursor: 0, limit: 1,
    workerState: { artifact, finalized: summary.counts.incomplete === 0 } }, db.pool);
}

test("Eligibility native snapshots preserve fields, errors and delayed-row cursors without publishing untouched inputs", async () => {
  const db = database();
  await publish(db, await workbook([2, 4]));
  const first = await readWorkerServiceResultPage("job", 0, 1, db.pool);
  assert.deepEqual([first.processed, first.pending, first.nextCursor], [2, 2, 1]);
  assert.equal((first.results[0].result.details as Record<string, string>).Address, "payer address");
  assert.deepEqual(db.stored().map(row => row.client_row_ref), ["A", "C"]);
  await publish(db, await workbook([2, 3, 4], new Map([[5, "No matching member was found."]])));
  assert.deepEqual(await readWorkerServiceResultPage("job", 0, 1, db.pool), { ...first,
    summary: { ...first.summary, counts: { ...first.summary.counts, success: 3, no_match: 1, incomplete: 0 },
      finalized_count: 4, outcome: "PARTIAL_SUCCESS" }, available: 4, processed: 4, pending: 0 });
  const rest = await readWorkerServiceResultPage("job", 1, 200, db.pool);
  assert.deepEqual(rest.results.map(row => [row.client_row_ref, row.status]), [["C", "SUCCESS"], ["B", "SUCCESS"], ["D", "NO_MATCH"]]);
  const stable = db.stored(); await publish(db, await workbook([2]));
  assert.deepEqual(db.stored(), stable);
  assert.deepEqual(await readWorkerServiceResultPage("job", 1, 200, db.pool), rest);
  await publish(db, await workbook([3]), "other");
  assert.deepEqual((await readWorkerServiceResultPage("other", 0, 1, db.pool)).results.map(row => row.client_row_ref), ["B"]);
  assert.deepEqual(await readWorkerServiceResultPage("job", 1, 200, db.pool), rest);
});

test("Eligibility outcomes and progress roll back together; read-only pages do not write", async () => {
  const db = database(); db.failNextProgressWrite();
  await assert.rejects(publish(db, await workbook([2])), /Progress write failed/);
  assert.equal(db.stored().length, 0); assert.equal(db.progress(), undefined);
  await publish(db, await workbook([2]));
  const before = db.queries.length;
  await readWorkerServiceResultPage("job", 0, 1, db.pool);
  await readWorkerServiceResultPage("job", 1, 1, db.pool);
  assert.ok(db.queries.slice(before).every(sql => sql.startsWith("SELECT")));
  assert.equal(db.progress()?.completed, db.stored().length);
});

type Job = Parameters<typeof finalizeCancelledServiceJob>[0];
function recovery(db: ReturnType<typeof database>, bytes: Uint8Array | null) {
  let reads = 0;
  const current = () => {
    const state = db.jobState(); const progress = db.progress();
    return { jobId: "job", workflowId: "eligibility-verification", portalId: "availity", clientSystem: state.client_system,
      status: state.status, ecsTaskArn: state.ecs_task_arn, currentCompleted: progress?.completed ?? 0, totalRows: refs.length,
      metadata: state.metadata, errorMessage: state.error_message, finishedAt: null } as Job;
  };
  const deps: NonNullable<Parameters<typeof finalizeCancelledServiceJob>[2]> = {
    find: async () => current(), refs: async () => { throw new Error("Use submitted DB references."); },
    snapshot: async () => { throw new Error("Claim Status snapshot must not be read."); },
    artifacts: async () => [], discover: async () => bytes ? [artifact] : [],
    workbook: async () => { reads++; return bytes; },
    publish: async () => { throw new Error("Claim Status publisher must not be used."); },
    publishEligibility: input => publishServiceResultPage(input, db.pool),
    notify: async () => 1, notifyStopped: async () => 1,
  };
  const stop = (exitCode = 137) => finalizeStoppedServiceJob(current(), { taskArn: "task-1", lastStatus: "STOPPED",
    containers: [{ name: "worker", exitCode }] }, deps);
  return { current, deps, stop, reads: () => reads };
}
for (const status of ["cancelling", "failed", "running"] as const) {
  test(`Eligibility stopped ${status}: preserve published and saved outcomes; close only unfinished claims`, async () => {
    const db = database(); await publish(db, await workbook([2]));
    db.setJobState({ status });
    const f = recovery(db, await workbook([2, 3], new Map([[4, "Cancelled - not processed"], [5, "Cancelled - not processed"]])));
    await f.stop();
    const page = await readWorkerServiceResultPage("job", 1, 200, db.pool);
    assert.deepEqual(page.results.map(row => [row.client_row_ref, row.status]), [["B", "SUCCESS"], ["C", "FAILED"], ["D", "FAILED"]]);
    assert.equal(page.results[1].error_category, status === "cancelling" ? "CANCELLED" : "TASK_FAILED");
    assert.equal(page.pending, 0); assert.equal(page.nextCursor, 4);
    const previous = db.stored(); await f.stop();
    assert.deepEqual(db.stored(), previous); assert.equal(f.reads(), 1);
  });
}
test("Eligibility prelaunch cancellation needs no files and completed publication needs no recovery", async () => {
  const db = database(); db.setJobState({ status: "cancelling", ecs_task_arn: null,
    metadata: { serviceClaimRefs: refs, expectedRowCount: refs.length, serviceCancelledBeforeLaunch: true } });
  const f = recovery(db, null);
  await finalizeCancelledServiceJob(f.current(), { kind: "before-launch" }, f.deps);
  assert.equal(f.reads(), 0); assert.equal(db.stored().length, 4);
  assert.ok(db.stored().every(row => row.result.error_category === "CANCELLED"));
  const completed = database(); await publish(completed, await workbook([2, 3, 4, 5])); completed.setJobState({ status: "completed" });
  const done = recovery(completed, null); await done.stop(0);
  assert.equal(done.reads(), 0); assert.equal(done.current().status, "completed");
});

test("Eligibility recovery keeps legacy partial results and action-required outcomes", async () => {
  const partial = await createEligibilityPartialOutput(await inputFile(), "availity");
  partial.record({ type: "eligibility_availity_result", rowIndex: 3, update: { "Coverage Status": "active" } });
  const summary = await normalizeEligibilityServiceWorkbook(partial.build(), refs, { requireStatusColumns: false, unfinishedAsPending: true });
  assert.deepEqual(summary.row_results.map(row => row.status), ["INCOMPLETE", "SUCCESS", "INCOMPLETE", "INCOMPLETE"]);
  const otp = await normalizeEligibilityServiceWorkbook(await workbook([], new Map([[2, "OTP verification required"]])), refs,
    { requireStatusColumns: false, unfinishedAsPending: true });
  assert.equal(otp.row_results[0].status, "ACTION_REQUIRED");
});

test("Eligibility worker publishes incremental and final bytes directly, without S3 reads or raw progress writes", async () => {
  let db = database();
  const env = { JOB_ID: "job", WORKFLOW_ID: "eligibility-verification", PORTAL_ID: "availity", PROJECT_ID: "medrevenue",
    FORM_FIELDS_JSON: JSON.stringify({ integrationMode: "service" }), DATABASE_URL: "test", WORKFLOW_OUTPUTS_BUCKET: "outputs" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const loader = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
  const original = loader._load;
  let runs = 0;
  loader._load = function(request, parent, isMain) {
    const name = request.replaceAll("\\", "/");
    if (name === "@/db") return { runDbWithRetry: async () => [{ status: db.jobState().status }] };
    if (name === "@/backend/src/workflows/registry") return { getAutomationRunner: () => ({ validateInput: () => ({}),
      run: async (_input: unknown, context: AutomationContext) => {
        runs++;
        await context.emit({ type: "progress", completed: 999, total: 999 });
        assert.equal(db.progress(), undefined);
        assert.ok(context.saveServiceResults);
        if (context.portalId === "medical") await context.emit({ type: "output_snapshot", filename: eligibilityServiceOutputFilenames("medical")[0],
          base64: (await workbook([2])).toString("base64") });
        else await context.saveServiceResults(await workbook([2]));
        assert.equal(db.progress()?.completed, 1);
        await context.emit({ type: "file_download", filename: context.portalId === "waystar" ? "waystar-eligibility-output.xlsx"
          : context.portalId === "uhc" ? "uhc-wellmed-eligibility-results.xlsx" : eligibilityServiceOutputFilenames(context.portalId)[0],
          base64: (await workbook([2, 3, 4, 5])).toString("base64") });
        assert.equal(db.progress()?.completed, 4);
      },
    }) };
    if (/(^|\/)workflow-db(?:\.ts)?$/.test(name)) return {
      getWorkflowJobById: async () => ({ jobId: "job", clientSystem: "AR_WORKFLOW", status: db.jobState().status, metadata: db.jobState().metadata }),
      updateWorkflowJob: async (input: { status?: string; currentCompleted?: number; totalRows?: number }) => {
        assert.equal(input.currentCompleted, undefined); assert.equal(input.totalRows, undefined);
        if (input.status) db.setJobState({ status: input.status });
      },
      appendWorkflowArtifact: async () => {}, appendWorkflowEvent: async () => 1, consumePendingWorkflowCommands: async () => [],
    };
    if (/(^|\/)result-publication-store(?:\.ts)?$/.test(name)) return {
      publishServiceResultPage: (input: Parameters<typeof publishServiceResultPage>[0]) => publishServiceResultPage(input, db.pool),
      readWorkerServiceResultPage: (job: string, cursor: number, limit: number) => readWorkerServiceResultPage(job, cursor, limit, db.pool),
    };
    if (/(^|\/)iehp-snapshot(?:\.ts)?$/.test(name)) return { loadServiceExpectedRefs: async () => refs };
    if (/(^|\/)websocket-publisher(?:\.ts)?$/.test(name)) return { publishWorkflowEvent: async () => {} };
    if (name === "@/backend/src/core/workflow-s3-storage") return { uploadWorkflowArtifact: async () => artifact.object_key };
    if (request === "@aws-sdk/client-s3") {
      const actual = original.call(this, request, parent, isMain) as object;
      return { ...actual, S3Client: class { send() { throw new Error("Worker must use in-memory output bytes."); } } };
    }
    return original.call(this, request, parent, isMain);
  };
  try {
    let worker: typeof import("../worker/claim-status-worker");
    try { worker = await import("../worker/claim-status-worker"); } finally { loader._load = original; }
    for (const [index, portal] of ELIGIBILITY_SERVICE_PORTALS.entries()) {
      process.env.PORTAL_ID = portal; process.env.PROJECT_ID = eligibilityServiceProject(portal); db = database();
      await worker.main();
      assert.equal(runs, index + 1); assert.equal(db.jobState().status, "completed"); assert.equal(db.stored().length, 4);
      db.setJobState({ status: "cancelling" });
      await worker.main(); assert.equal(runs, index + 1); // A delayed launch cannot start cancelled portal work.
      getScrapeJob("job")?.cleanupTimer?.unref();
    }
  } finally {
    loader._load = original;
    getScrapeJob("job")?.cleanupTimer?.unref();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
