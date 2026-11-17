import test from "node:test";
import assert from "node:assert/strict";
import { handleWorkerTaskStopped, type EcsTaskStoppedEvent } from "./ecs-task-stopped";

const cluster = "arn:aws:ecs:us-east-1:123:cluster/workers";
const definition = "arn:aws:ecs:us-east-1:123:task-definition/worker:2";
const taskArn = `${cluster.replace(":cluster/", ":task/")}/task-1`;
const event = (): EcsTaskStoppedEvent => ({ source: "aws.ecs", "detail-type": "ECS Task State Change",
  detail: { clusterArn: cluster, taskArn, taskDefinitionArn: definition, lastStatus: "STOPPED",
    stoppedReason: "Essential container exited", containers: [{ name: "worker", exitCode: 137, reason: "OutOfMemoryError" }],
    overrides: { containerOverrides: [{ name: "worker", environment: [{ name: "JOB_ID", value: "job" }] }] } } });

test("ECS stopped events filter our workers, identify jobs, and invoke the common reconciler", async t => {
  const previous = { cluster: process.env.WORKER_CLUSTER_ARN, definition: process.env.WORKER_TASK_DEFINITION_ARN };
  process.env.WORKER_CLUSTER_ARN = cluster; process.env.WORKER_TASK_DEFINITION_ARN = definition;
  t.after(() => {
    for (const [key, value] of [["WORKER_CLUSTER_ARN", previous.cluster], ["WORKER_TASK_DEFINITION_ARN", previous.definition]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  type Deps = NonNullable<Parameters<typeof handleWorkerTaskStopped>[1]>;
  type Job = NonNullable<Awaited<ReturnType<Deps["find"]>>>;
  let job: Job | null;
  let reconciled: Array<{ job: Job; task: EcsTaskStoppedEvent["detail"] }>;
  let describes = 0;
  let lookups = 0;
  const deps: Deps = {
    find: async id => { assert.equal(id, "job"); lookups++; return job; },
    describe: async () => { describes++; return { startedBy: "job" }; },
    reconcile: async (value, task) => { reconciled.push({ job: value!, task }); return value; },
  };
  const reset = () => {
    job = { jobId: "job", clientSystem: "AR_WORKFLOW", status: "running", ecsTaskArn: taskArn } as Job;
    reconciled = []; describes = 0; lookups = 0;
  };
  reset();
  await t.test("OOM, success, cancellation and force stop all reach reconciliation for website and AR jobs", async () => {
    for (const clientSystem of [null, "AR_WORKFLOW"]) for (const exitCode of [0, 137, 143]) {
      reset(); job!.clientSystem = clientSystem;
      const value = event(); value.detail!.containers = [{ name: "worker", exitCode }];
      await handleWorkerTaskStopped(value, deps);
      assert.equal(reconciled.length, 1); assert.equal(describes, 0); assert.equal(lookups, 1);
      assert.equal(reconciled[0].task?.containers?.[0].exitCode, exitCode);
    }
  });
  await t.test("non-stopped states, unrelated sources, clusters and task families never access the DB", async () => {
    for (const change of [
      (value: EcsTaskStoppedEvent) => { value.source = "other"; },
      (value: EcsTaskStoppedEvent) => { value["detail-type"] = "other"; },
      (value: EcsTaskStoppedEvent) => { value.detail!.lastStatus = "RUNNING"; },
      (value: EcsTaskStoppedEvent) => { value.detail!.clusterArn = "other"; },
      (value: EcsTaskStoppedEvent) => { value.detail!.taskDefinitionArn = definition.replace("/worker:", "/other:"); },
    ]) {
      reset(); const value = event(); change(value);
      await handleWorkerTaskStopped(value, deps); assert.equal(lookups, 0); assert.equal(reconciled.length, 0);
    }
  });
  await t.test("an older task-definition revision and an ARN not yet saved by RunTask are supported", async () => {
    reset(); job!.ecsTaskArn = null;
    const value = event(); value.detail!.taskDefinitionArn = definition.replace(":2", ":1");
    await handleWorkerTaskStopped(value, deps);
    assert.equal(reconciled[0].job.ecsTaskArn, taskArn);
  });
  await t.test("missing overrides fall back to ECS startedBy; stale tasks and deleted jobs are ignored", async () => {
    reset(); const value = event(); delete value.detail!.overrides;
    await handleWorkerTaskStopped(value, deps); assert.equal(describes, 1); assert.equal(reconciled.length, 1);
    reset(); job!.ecsTaskArn = "different-task";
    await handleWorkerTaskStopped(event(), deps); assert.equal(reconciled.length, 0);
    reset(); job = null;
    await handleWorkerTaskStopped(event(), deps); assert.equal(reconciled.length, 0);
  });
  await t.test("DB/recovery failures propagate for Lambda retries; no job is invented from an unidentified event", async () => {
    reset();
    await assert.rejects(handleWorkerTaskStopped(event(), { ...deps, reconcile: async () => { throw new Error("DB unavailable"); } }), /DB unavailable/);
    const value = event(); delete value.detail!.overrides;
    await assert.rejects(handleWorkerTaskStopped(value, { ...deps, describe: async () => null }), /could not be mapped/);
  });
});
