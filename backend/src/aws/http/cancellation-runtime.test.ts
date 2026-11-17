import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { getWorkflowJobById } from "../runtime/workflow-db";
import type { CancellationConfirmation, StoppedWorkerTask } from "../service/service-cancellation-finalizer";
import { ELIGIBILITY_SERVICE_PORTALS } from "../service/eligibility-portals";

type Job = NonNullable<Awaited<ReturnType<typeof getWorkflowJobById>>>;
test("cancel and force-stop handlers and watchdog share stop-confirmed result finalization", async t => {
  let job: Job;
  let taskStatus = "RUNNING";
  let discoveredTask: string | null = "task-1";
  let finals: CancellationConfirmation[] = [];
  let stopCalls = 0;
  let launchCalls = 0;
  const copy = () => structuredClone(job);
  function reset(status: Job["status"] = "running", task: string | null = "task-1") {
    job = { jobId: "job", userId: "service:AR_WORKFLOW", clientSystem: "AR_WORKFLOW", workflowId: "claim-status", portalId: "iehp",
      status, ecsTaskArn: task, currentCompleted: 1, totalRows: 4, updatedAt: new Date().toISOString(),
      metadata: { expectedRowCount: 4 }, finishedAt: status === "cancelled" ? new Date().toISOString() : null } as Job;
    taskStatus = "RUNNING"; discoveredTask = task; finals = []; stopCalls = 0; launchCalls = 0;
  }
  reset();
  const db = {
    getWorkflowJobById: async () => copy(), getWorkflowJobForUser: async () => copy(),
    cancelUnstartedServiceJob: async () => {
      if (!["preparing", "queued"].includes(job.status)) return false;
      job.status = "cancelling"; job.metadata = { expectedRowCount: 4, serviceCancelledBeforeLaunch: true }; return true;
    },
    requestServiceJobCancellation: async () => {
      if (!["starting", "running", "waiting_otp"].includes(job.status)) return false;
      job.status = "cancelling";
      job.metadata = { expectedRowCount: 4, serviceCancellationRequestedAt: new Date().toISOString() }; return true;
    },
    confirmUnstartedServiceCancellation: async () => {
      assert.equal(job.ecsTaskArn, null); assert.equal(job.status, "cancelling");
      job.metadata = { ...(job.metadata as object), serviceCancellationTaskAbsent: true }; return true;
    },
    createWorkflowCommand: async () => {}, appendWorkflowEvent: async () => 1,
    expirePendingWorkflowCommands: async () => {}, listWatchdogWorkflowJobs: async () => [copy()],
    updateWorkflowJob: async (value: Partial<Job>) => { Object.assign(job, value); },
    claimWorkflowJobLaunch: async () => { if (job.status !== "queued") return false; job.status = "starting"; return true; },
  };
  const ecs = {
    describeWorkerTask: async () => ({ taskArn: "task-1", lastStatus: taskStatus,
      containers: [{ name: "worker", exitCode: 137, reason: "OutOfMemoryError" }] }),
    findWorkerTaskByJobId: async () => discoveredTask,
    stopWorkerTask: async () => { stopCalls++; taskStatus = "STOPPING"; },
    runWorkerTask: async () => { launchCalls++; return "task-1"; },
    WorkerTaskLaunchRejectedError: class extends Error {},
  };
  const finalizer = { finalizeCancelledServiceJob: async (_job: Job, proof: CancellationConfirmation) => {
    if (proof.kind === "stopped") assert.equal(proof.lastStatus, "STOPPED");
    if (proof.kind === "before-launch") assert.equal((job.metadata as { serviceCancelledBeforeLaunch: boolean }).serviceCancelledBeforeLaunch, true);
    finals.push(proof); job.status = "cancelled"; job.currentCompleted = job.totalRows;
    job.metadata = { ...(job.metadata as object), serviceCancellationFinalizedAt: new Date().toISOString() }; return copy();
  }, finalizeStoppedServiceJob: async (value: Job, task: StoppedWorkerTask): Promise<Job> => {
    if (["cancelling", "cancelled"].includes(job.status)) return finalizer.finalizeCancelledServiceJob(value,
      { kind: "stopped", lastStatus: task.lastStatus, taskArn: task.taskArn });
    assert.equal(task.lastStatus, "STOPPED"); finals.push({ kind: "stopped", lastStatus: task.lastStatus, taskArn: task.taskArn });
    job.status = "failed"; job.currentCompleted = job.totalRows; return copy();
  } };
  const loader = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
  const original = loader._load;
  loader._load = function(request, parent, isMain) {
    const name = request.replaceAll("\\", "/");
    if (/(^|\/)workflow-db(?:\.ts)?$/.test(name)) return db;
    if (/(^|\/)ecs(?:\.ts)?$/.test(name)) return ecs;
    if (/(^|\/)service-cancellation-finalizer(?:\.ts)?$/.test(name)) return finalizer;
    return original.call(this, request, parent, isMain);
  };
  let jobs: typeof import("./jobs");
  let watchdog: typeof import("../runtime/job-watchdog");
  try { jobs = await import("./jobs"); watchdog = await import("../runtime/job-watchdog"); }
  finally { loader._load = original; }

  await t.test("queued/preparing cancellation blocks launch and finalizes before acknowledging", async () => {
    for (const status of ["preparing", "queued"] as const) {
      reset(status, null);
      const result = await jobs.cancelIntegratedWorkflowJob("job", "AR_WORKFLOW", "actor");
      assert.deepEqual([result.status, result.terminal, job.currentCompleted], ["cancelled", true, 4]);
      assert.equal(finals[0].kind, "before-launch");
      await assert.rejects(jobs.launchQueuedWorkflowJob("job", job.userId));
      assert.equal(launchCalls, 0);
    }
  });
  await t.test("normal cancellation and OTP cancellation wait for STOPPED", async () => {
    for (const status of ["running", "waiting_otp"] as const) {
      reset(status);
      assert.equal((await jobs.cancelIntegratedWorkflowJob("job", "AR_WORKFLOW", "actor")).terminal, false);
      assert.equal(finals.length, 0); assert.equal(job.status, "cancelling");
      taskStatus = "STOPPED";
      await jobs.reconcileAwsJobRuntime(copy());
      assert.equal(finals.length, 1); assert.equal(job.status, "cancelled");
    }
  });
  await t.test("force stop requests ECS stop but cannot close outcomes until the task stops", async () => {
    reset();
    const response = await jobs.forceStopJob({ pathParameters: { jobId: "job" }, body: "{}",
      requestContext: { authorizer: { jwt: { claims: { sub: "admin", "cognito:groups": "ADMIN" } } } } });
    assert.equal(response.statusCode, 200); assert.equal(stopCalls, 1);
    assert.equal(finals.length, 0); assert.equal(job.status, "cancelling");
    taskStatus = "STOPPED";
    await watchdog.runStalledJobWatchdog();
    assert.equal(finals.length, 1); assert.equal(job.status, "cancelled");
  });
  await t.test("startup cancellation without a discoverable task is finalized after absence confirmation", async () => {
    reset("cancelling", null);
    job.metadata = { expectedRowCount: 4, serviceCancellationRequestedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
      deadlineStopRequestedAt: new Date().toISOString() };
    await watchdog.runStalledJobWatchdog();
    assert.equal(finals.length, 1); assert.equal(finals[0].kind, "task-absent");
    assert.equal(job.status, "cancelled"); assert.equal(stopCalls, 0);
  });
  await t.test("watchdog revisits legacy cancelled jobs whose result delivery was left incomplete", async () => {
    reset("cancelled");
    await watchdog.runStalledJobWatchdog();
    assert.equal(finals.length, 1); assert.equal(finals[0].kind, "already-cancelled");
    assert.equal(job.currentCompleted, job.totalRows);
  });
  await t.test("a missed crash event is detected for website and AR tasks without waiting for a stall or deadline", async () => {
    for (const clientSystem of [null, "AR_WORKFLOW"]) {
      reset(); job.clientSystem = clientSystem; taskStatus = "STOPPED";
      const result = await watchdog.runStalledJobWatchdog();
      assert.deepEqual(result.errors, []);
      assert.equal(job.status, "failed"); assert.equal(stopCalls, 0);
      if (!clientSystem) assert.match(job.errorMessage!, /OutOfMemoryError/);
    }
  });
  await t.test("duplicate stopped events preserve an already completed website job", async () => {
    reset("completed"); job.clientSystem = null; taskStatus = "STOPPED";
    await jobs.reconcileAwsJobRuntime(copy(), await ecs.describeWorkerTask());
    assert.equal(job.status, "completed"); assert.equal(stopCalls, 0);
  });
  await t.test("Eligibility before-launch cancellation, polling and watchdog use the same stopped-task recovery", async () => {
    for (const portal of ELIGIBILITY_SERVICE_PORTALS) {
      reset("queued", null); job.workflowId = "eligibility-verification"; job.portalId = portal;
      assert.equal((await jobs.cancelIntegratedWorkflowJob("job", "AR_WORKFLOW", "actor")).terminal, true);
      assert.equal(finals[0].kind, "before-launch");
      for (const status of ["running", "cancelled", "failed"] as const) {
        reset(status); job.workflowId = "eligibility-verification"; job.portalId = portal;
        await jobs.reconcileAwsJobRuntime(copy());
        assert.equal(finals.length, 0); // No recovery while the task can still publish.
        taskStatus = "STOPPED";
        await watchdog.runStalledJobWatchdog();
        assert.equal(finals.length, 1); assert.equal(job.currentCompleted, 4);
      }
    }
  });
});
