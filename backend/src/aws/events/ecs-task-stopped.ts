import type { Task } from "@aws-sdk/client-ecs";
import { getWorkflowJobById } from "../runtime/workflow-db";
import { describeWorkerTask } from "../runtime/ecs";
import { reconcileAwsJobRuntime } from "../http/jobs";

export type EcsTaskStoppedEvent = {
  source?: string; "detail-type"?: string;
  detail?: Pick<Task, "taskArn" | "clusterArn" | "taskDefinitionArn" | "lastStatus" | "stopCode" |
    "stoppedReason" | "containers" | "overrides" | "startedBy">;
};
const defaults = {
  find: (jobId: string): Promise<Awaited<ReturnType<typeof getWorkflowJobById>> | null> => getWorkflowJobById(jobId),
  describe: describeWorkerTask, reconcile: reconcileAwsJobRuntime,
};

/** STOPPED also includes successful completion and user cancellation. Never infer
 * failure solely from the task state or log the event's environment overrides. */
export async function handleWorkerTaskStopped(event: EcsTaskStoppedEvent, deps = defaults) {
  const task = event.detail;
  if (event.source !== "aws.ecs" || event["detail-type"] !== "ECS Task State Change" || task?.lastStatus !== "STOPPED") return;
  const cluster = process.env.WORKER_CLUSTER_ARN;
  const definition = process.env.WORKER_TASK_DEFINITION_ARN;
  if (!cluster || !definition) throw new Error("Worker cluster and task definition must be configured.");
  const prefix = definition.slice(0, definition.lastIndexOf(":") + 1);
  if (task.clusterArn !== cluster || !task.taskDefinitionArn?.startsWith(prefix)) return;
  if (!task.taskArn) throw new Error("Stopped worker event is missing its task ARN.");

  // RunTask supplies JOB_ID in overrides and startedBy. The event carries the
  // overrides even if its delivery is delayed beyond ECS stopped-task retention.
  const worker = task.overrides?.containerOverrides?.find(item => item.name === (process.env.WORKER_CONTAINER_NAME || "worker"));
  let jobId = worker?.environment?.find(item => item.name === "JOB_ID")?.value ?? task.startedBy;
  if (!jobId) jobId = (await deps.describe(task.taskArn))?.startedBy;
  if (!jobId) throw new Error("Stopped worker could not be mapped to its job; retry the event.");
  const job = await deps.find(jobId);
  if (!job) return; // Job was deleted; do not recreate it from an event.
  if (job.ecsTaskArn && job.ecsTaskArn !== task.taskArn) return; // A stale task must not affect a later execution.
  // A very short-lived task can stop before RunTask's caller saves its ARN.
  await deps.reconcile({ ...job, ecsTaskArn: task.taskArn }, task);
}

export async function handler(event: EcsTaskStoppedEvent) {
  await handleWorkerTaskStopped(event);
}
