import {
  appendWorkflowEvent,
  createWorkflowCommand,
  confirmUnstartedServiceCancellation,
  expirePendingWorkflowCommands,
  listWatchdogWorkflowJobs,
  updateWorkflowJob,
  updateWorkflowJobMetadata,
} from "./workflow-db";
import { describeWorkerTask, findWorkerTaskByJobId, stopWorkerTask } from "./ecs";
import { reconcileAwsJobRuntime } from "../http/jobs";

const DEFAULT_STALL_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_CANCEL_RETRY_DELAY_MS = 60 * 1000;
const DEFAULT_CANCEL_ATTEMPTS = 3;
const SERVICE_CANCEL_GRACE_MS = 2 * 60 * 1000;
const SERVICE_UNSTARTED_CONFIRM_MS = 15 * 60 * 1000;

type WorkflowJob = Awaited<ReturnType<typeof listWatchdogWorkflowJobs>>[number];

type WatchdogState = {
  lastCompleted?: number;
  lastProgressAt?: string;
  cancelAttempts?: number;
  lastCancelAt?: string;
  forceStoppedAt?: string;
};

type WatchdogResult = {
  checked: number;
  reset: number;
  skipped: number;
  cancelRequested: number;
  forceStopped: number;
  errors: Array<{ jobId: string; message: string }>;
};

function numberEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function watchdogState(job: WorkflowJob): WatchdogState {
  const metadata = job.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  const state = (metadata as Record<string, unknown>).watchdog;
  if (!state || typeof state !== "object" || Array.isArray(state)) return {};
  return state as WatchdogState;
}

function parseTime(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function terminalStatus(status: string): boolean {
  return status === "completed" || status === "partial_success" || status === "failed" || status === "cancelled";
}

async function handleServiceDeadline(job: WorkflowJob, now: number, nowIso: string): Promise<boolean> {
  if (!job.clientSystem) return false;
  const metadata = job.metadata as { deadlineAt?: unknown; deadlineStopRequestedAt?: unknown } | null;
  const deadline = typeof metadata?.deadlineAt === "string" ? Date.parse(metadata.deadlineAt) : Number.NaN;
  if (!Number.isFinite(deadline) || now < deadline) return false;
  const requestedAt = typeof metadata?.deadlineStopRequestedAt === "string" ? metadata.deadlineStopRequestedAt : null;
  if (!requestedAt) await updateWorkflowJobMetadata(job.jobId, { deadlineStopRequestedAt: nowIso });
  const current = await reconcileAwsJobRuntime({
    ...job,
    metadata: { ...(job.metadata as Record<string, unknown>), deadlineStopRequestedAt: requestedAt ?? nowIso },
  });
  if (!current || terminalStatus(current.status)) return true;
  if (current.ecsTaskArn) {
    const task = await describeWorkerTask(current.ecsTaskArn);
    if (task?.lastStatus === "STOPPED") {
      await reconcileAwsJobRuntime(current);
    } else if (task && task.lastStatus !== "STOPPING") {
      await stopWorkerTask(current.ecsTaskArn, "Execution deadline exceeded.");
    }
  } else if (current.status !== "starting" || now - Date.parse(requestedAt ?? nowIso) > 2 * 60_000) {
    await updateWorkflowJob({ jobId: job.jobId, status: "failed", errorMessage: "Execution deadline exceeded before the worker started." });
  }
  return true;
}

async function handleServiceCancellation(job: WorkflowJob, now: number): Promise<boolean> {
  if (!job.clientSystem || job.status !== "cancelling") return false;
  const current = await reconcileAwsJobRuntime(job);
  if (!current || terminalStatus(current.status)) return true;
  const requestedAt = parseTime((current.metadata as { serviceCancellationRequestedAt?: string } | null)?.serviceCancellationRequestedAt);
  let taskArn = current.ecsTaskArn;
  if (!taskArn) {
    taskArn = await findWorkerTaskByJobId(current.jobId);
    if (taskArn) await updateWorkflowJob({ jobId: current.jobId, ecsTaskArn: taskArn });
  }
  if (!taskArn) {
    if (requestedAt && now - requestedAt >= SERVICE_UNSTARTED_CONFIRM_MS) {
      await confirmUnstartedServiceCancellation(current.jobId, new Date(now - SERVICE_UNSTARTED_CONFIRM_MS).toISOString());
    }
    return true;
  }
  const task = await describeWorkerTask(taskArn);
  if (task?.lastStatus === "STOPPED") {
    await reconcileAwsJobRuntime({ ...current, ecsTaskArn: taskArn });
  } else if (task && task.lastStatus !== "STOPPING" && requestedAt && now - requestedAt >= SERVICE_CANCEL_GRACE_MS) {
    await stopWorkerTask(taskArn, "Integrated job cancellation grace period elapsed.");
  }
  return true;
}

async function jobStillActive(job: WorkflowJob): Promise<boolean> {
  if (!job.ecsTaskArn) return false;
  const task = await describeWorkerTask(job.ecsTaskArn).catch(() => null);
  const status = task?.lastStatus?.toUpperCase();
  return status === "PENDING" || status === "RUNNING";
}

async function updateState(job: WorkflowJob, state: WatchdogState): Promise<void> {
  await updateWorkflowJobMetadata(job.jobId, { watchdog: state });
}

async function requestCancel(job: WorkflowJob, state: WatchdogState, attempt: number, totalAttempts: number, nowIso: string): Promise<void> {
  await createWorkflowCommand({
    jobId: job.jobId,
    commandType: "cancel",
    createdBy: "backend-watchdog",
  });
  await updateWorkflowJob({ jobId: job.jobId, status: "cancelling" });
  await appendWorkflowEvent(job.jobId, "watchdog_cancel_requested", {
    type: "log",
    message: `Backend watchdog requested cancel attempt ${attempt} of ${totalAttempts}; progress did not move for 20 minutes.`,
  }).catch(() => {});
  await updateState(job, {
    ...state,
    cancelAttempts: attempt,
    lastCancelAt: nowIso,
  });
}

async function forceStop(job: WorkflowJob, state: WatchdogState, nowIso: string): Promise<void> {
  const reason = "Progress did not move for 20 minutes; backend watchdog force-stopped the job.";
  if (job.ecsTaskArn && await jobStillActive(job)) {
    await stopWorkerTask(job.ecsTaskArn, reason);
  }
  await updateWorkflowJob({ jobId: job.jobId, status: "cancelled", errorMessage: reason });
  await appendWorkflowEvent(job.jobId, "watchdog_force_stopped", {
    type: "cancellation_acknowledged",
    reason,
    initiatedBy: "backend-watchdog",
  }).catch(() => {});
  await updateState(job, {
    ...state,
    forceStoppedAt: nowIso,
  });
}

export async function runStalledJobWatchdog(): Promise<WatchdogResult> {
  await expirePendingWorkflowCommands();
  const stallTimeoutMs = numberEnv("WORKFLOW_STALL_TIMEOUT_MS", DEFAULT_STALL_TIMEOUT_MS);
  const cancelRetryDelayMs = numberEnv("WORKFLOW_STALL_CANCEL_RETRY_DELAY_MS", DEFAULT_CANCEL_RETRY_DELAY_MS);
  const cancelAttempts = Math.max(1, Math.floor(numberEnv("WORKFLOW_STALL_CANCEL_ATTEMPTS", DEFAULT_CANCEL_ATTEMPTS)));
  const jobs = await listWatchdogWorkflowJobs();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const result: WatchdogResult = { checked: jobs.length, reset: 0, skipped: 0, cancelRequested: 0, forceStopped: 0, errors: [] };

  for (const job of jobs) {
    try {
      if (terminalStatus(job.status)) {
        result.skipped += 1;
        continue;
      }

      if (await handleServiceCancellation(job, now) || await handleServiceDeadline(job, now, nowIso)) {
        result.skipped += 1;
        continue;
      }

      // Integrated jobs use their explicit deadline so polling never sees a
      // terminal status before the worker has stopped and S3 is reconciled.
      if (job.clientSystem) {
        result.skipped += 1;
        continue;
      }

      if (job.status === "waiting_otp") {
        result.skipped += 1;
        continue;
      }

      const state = watchdogState(job);
      const completed = job.currentCompleted ?? 0;
      const progressed = state.lastCompleted === undefined || completed > state.lastCompleted;
      if (progressed) {
        await updateState(job, {
          lastCompleted: completed,
          lastProgressAt: nowIso,
          cancelAttempts: 0,
        });
        result.reset += 1;
        continue;
      }

      const lastProgressAt = parseTime(state.lastProgressAt) || parseTime(job.startedAt) || parseTime(job.updatedAt) || now;
      if (now - lastProgressAt < stallTimeoutMs) {
        result.skipped += 1;
        continue;
      }

      const attempts = Math.max(0, Math.floor(state.cancelAttempts ?? 0));
      const lastCancelAt = parseTime(state.lastCancelAt);
      if (attempts < cancelAttempts) {
        if (lastCancelAt && now - lastCancelAt < cancelRetryDelayMs) {
          result.skipped += 1;
          continue;
        }
        await requestCancel(job, state, attempts + 1, cancelAttempts, nowIso);
        result.cancelRequested += 1;
        continue;
      }

      if (lastCancelAt && now - lastCancelAt < cancelRetryDelayMs) {
        result.skipped += 1;
        continue;
      }

      await forceStop(job, state, nowIso);
      result.forceStopped += 1;
    } catch (error) {
      result.errors.push({
        jobId: job.jobId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
