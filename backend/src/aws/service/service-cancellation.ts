export type CancellableServiceJob = { jobId: string; status: string; clientSystem: string | null };

export function isTerminalServiceJob(status: string): boolean {
  return status === "completed" || status === "partial_success" || status === "failed" || status === "cancelled";
}

export class ServiceCancellationConflict extends Error {}

export async function cancelServiceExecution<TJob extends CancellableServiceJob>(params: {
  find: () => Promise<TJob>;
  cancelBeforeLaunch: (job: TJob) => Promise<boolean>;
  markCancelling: (job: TJob) => Promise<boolean>;
  requestWorkerCancel: (job: TJob) => Promise<void>;
  reconcile: (job: TJob) => Promise<TJob | null>;
}): Promise<{ jobId: string; status: string; terminal: boolean }> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const job = await params.find();
    if (isTerminalServiceJob(job.status)) {
      return { jobId: job.jobId, status: job.status, terminal: true };
    }
    if (job.status === "preparing" || job.status === "queued") {
      if (!await params.cancelBeforeLaunch(job)) continue;
      return { jobId: job.jobId, status: "cancelled", terminal: true };
    }
    if (job.status === "starting" || job.status === "running" || job.status === "waiting_otp") {
      if (!await params.markCancelling(job)) continue;
      await params.requestWorkerCancel(job);
    }
    const current = await params.find();
    const reconciled = await params.reconcile(current) ?? current;
    return { jobId: reconciled.jobId, status: reconciled.status, terminal: isTerminalServiceJob(reconciled.status) };
  }
  throw new ServiceCancellationConflict("Job state changed during cancellation; retry the same request.");
}
