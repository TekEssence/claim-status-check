import { GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import type { Task } from "@aws-sdk/client-ecs";
import { buildWorkflowS3Key } from "../../core/workflow-s3-storage";
import { appendWorkflowEvent, getWorkflowJobById, listArtifactsForJob } from "../runtime/workflow-db";
import { completedWorkerWorkbookResults, createClaimResultPublisher } from "../worker/claim-result-publisher";
import { loadServiceExpectedRefs, type ServiceWorkbookArtifact } from "./iehp-snapshot";
import { ServicePublicationError } from "./result-publication";
import { publishWorkerResultSnapshot, publishServiceResultPage, type WorkerResultFinalization } from "./result-publication-store";
import { normalizeEligibilityServiceWorkbook } from "./eligibility-results";
import { summarizeServiceResults } from "./result-summary";
import { isEligibilityServicePortal, eligibilityServiceOutputFilenames } from "./eligibility-portals";
import { loadWorkerResultSnapshot } from "./worker-result-snapshot";
import type { WorkerResultManifest } from "./worker-result-contract";

type Job = NonNullable<Awaited<ReturnType<typeof getWorkflowJobById>>>;
export type StoppedWorkerTask = Pick<Task, "taskArn" | "lastStatus" | "stopCode" | "stoppedReason" | "containers">;
export type CancellationConfirmation = { kind: "before-launch" } | { kind: "task-absent" } | { kind: "already-cancelled" }
  | { kind: "stopped"; lastStatus?: string; taskArn?: string };
let s3: S3Client | undefined;
async function readWorkbook(artifact: ServiceWorkbookArtifact): Promise<Uint8Array | null> {
  try {
    s3 ??= new S3Client({ region: process.env.WORKFLOW_S3_REGION });
    const object = await s3.send(new GetObjectCommand({ Bucket: artifact.bucket, Key: artifact.object_key }));
    if (!object.Body) throw new Error("Saved worker workbook is empty.");
    return object.Body.transformToByteArray();
  } catch (error) {
    const missing = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (missing.name === "NoSuchKey" || missing.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
async function discoverWorkbooks(job: Job): Promise<ServiceWorkbookArtifact[]> {
  if (!job.outputBucket || !job.outputPrefix) throw new Error("Worker output location is unavailable.");
  const day = 86400000;
  const first = Math.floor(Date.parse(job.createdAt) / day) * day;
  const last = Math.floor(Date.parse(job.finishedAt ?? new Date().toISOString()) / day) * day;
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) throw new Error("Execution dates are unavailable.");
  const prefixes = new Set([`${job.outputPrefix}/`]);
  for (let date = first; date <= last; date += day) {
    const key = buildWorkflowS3Key({ workflowId: job.workflowId === "eligibility-verification" ? "eligibility-verification" : "claim-status",
      jobId: job.jobId, area: "output", filename: "recovery", now: new Date(date) });
    prefixes.add(key.slice(0, key.lastIndexOf("/") + 1));
  }
  s3 ??= new S3Client({ region: process.env.WORKFLOW_S3_REGION });
  // An upload can finish immediately before the task dies, before its JSON or
  // artifact row is saved. Discover those objects too, including midnight rollover.
  const found = await Promise.all([...prefixes].map(async prefix => {
    const rows: Array<{ artifact: ServiceWorkbookArtifact; modified: number }> = [];
    let token: string | undefined;
    do {
      const page = await s3!.send(new ListObjectsV2Command({ Bucket: job.outputBucket!, Prefix: prefix, ContinuationToken: token }));
      for (const object of page.Contents ?? []) if (object.Key?.toLowerCase().endsWith(".xlsx")) {
        rows.push({ artifact: { bucket: job.outputBucket!, object_key: object.Key, filename: object.Key.split("/").pop()!,
          artifact_type: "output_snapshot", size_bytes: object.Size ?? 0, etag: object.ETag ?? null },
          modified: object.LastModified?.getTime() ?? 0 });
      }
      if (page.IsTruncated && !page.NextContinuationToken) throw new Error("Worker output listing is incomplete.");
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return rows;
  }));
  return found.flat().sort((a, b) => b.modified - a.modified).map(row => row.artifact);
}
const defaults = {
  find: getWorkflowJobById,
  refs: loadServiceExpectedRefs,
  snapshot: (job: Job, refs: string[]) => loadWorkerResultSnapshot(job, {}, refs),
  artifacts: listArtifactsForJob,
  workbook: readWorkbook,
  discover: discoverWorkbooks,
  publish: (job: Job, refs: string[], manifest: WorkerResultManifest, finalization?: WorkerResultFinalization) =>
    publishWorkerResultSnapshot(job.jobId, job.portalId, refs, manifest, undefined, finalization ?? job.clientSystem!),
  notify: (jobId: string) => appendWorkflowEvent(jobId, "cancelled", { type: "cancelled", message: "Job cancelled; remaining claims finalized." }),
  notifyStopped: (job: Job) => appendWorkflowEvent(job.jobId, job.status, { type: job.status, message: job.errorMessage }),
};

/** Called only after launch is blocked or execution is confirmed stopped. */
export function finalizeCancelledServiceJob(job: Job, confirmation: CancellationConfirmation, deps: typeof defaults & { publishEligibility?: typeof publishServiceResultPage } = defaults): Promise<Job> {
  return finalizeServiceResults(job, confirmation, deps);
}

/** Reuse cancellation recovery for a confirmed clean exit, crash or deadline stop. */
export function finalizeStoppedServiceJob(job: Job, task: StoppedWorkerTask, deps: typeof defaults & { publishEligibility?: typeof publishServiceResultPage } = defaults): Promise<Job> {
  return finalizeServiceResults(job, { kind: "stopped", lastStatus: task.lastStatus, taskArn: task.taskArn }, deps, task);
}

async function finalizeServiceResults(job: Job, confirmation: CancellationConfirmation, deps: typeof defaults & { publishEligibility?: typeof publishServiceResultPage }, task?: StoppedWorkerTask): Promise<Job> {
  const current = await deps.find(job.jobId);
  const eligibility = current?.workflowId === "eligibility-verification" && isEligibilityServicePortal(current.portalId);
  if (!current || !job.clientSystem || current.clientSystem !== job.clientSystem || (current.workflowId !== "claim-status" && !eligibility)) {
    throw new ServicePublicationError(404, "Job not found.");
  }
  const metadata = current.metadata as { serviceClaimRefs?: unknown; expectedRowCount?: unknown;
    serviceCancelledBeforeLaunch?: boolean; serviceCancellationTaskAbsent?: boolean; serviceCancellationFinalizedAt?: unknown;
    deadlineStopRequestedAt?: unknown; serviceTaskFinalizedAt?: unknown;
    workerResultState?: { artifact?: ServiceWorkbookArtifact | null; finalized?: boolean; countsVersion?: number } };
  const cancelled = !task || ["cancelling", "cancelled"].includes(current.status);
  if (confirmation.kind === "stopped" && (confirmation.lastStatus !== "STOPPED"
    || !confirmation.taskArn || (current.ecsTaskArn && current.ecsTaskArn !== confirmation.taskArn))) {
    throw new ServicePublicationError(409, "Worker stop or blocked launch must be confirmed before closing claim results.");
  }
  if ((metadata.serviceTaskFinalizedAt || metadata.serviceCancellationFinalizedAt)
    && ["cancelled", "completed", "partial_success", "failed"].includes(current.status)) return current;
  // A worker that already committed its complete terminal outcome needs no recovery.
  if (!cancelled && ["completed", "partial_success", "failed"].includes(current.status)
    && metadata.workerResultState?.finalized && metadata.workerResultState.countsVersion === 1
    && current.currentCompleted === metadata.expectedRowCount) return current;
  if ((!task && !["cancelling", "cancelled"].includes(current.status))
    || (confirmation.kind === "before-launch" && (!metadata.serviceCancelledBeforeLaunch || current.ecsTaskArn))
    || (confirmation.kind === "task-absent" && (!metadata.serviceCancellationTaskAbsent || current.ecsTaskArn))
    || (confirmation.kind === "already-cancelled" && (current.status !== "cancelled" || !current.finishedAt))) {
    throw new ServicePublicationError(409, "Worker stop or blocked launch must be confirmed before closing claim results.");
  }
  try {
    let refs = metadata.serviceClaimRefs;
    if (!Array.isArray(refs) || refs.length !== metadata.expectedRowCount || refs.some(ref => typeof ref !== "string" || !ref)
      || new Set(refs).size !== refs.length) refs = await deps.refs(current);
    if (!Array.isArray(refs) || !refs.length || refs.some(ref => typeof ref !== "string" || !ref)
      || new Set(refs).size !== refs.length || (typeof metadata.expectedRowCount === "number" && refs.length !== metadata.expectedRowCount)) {
      throw new Error("Submitted claim references are unavailable.");
    }
    const expectedRefs = refs as string[];
    const worker = task?.containers?.find(container => container.name === (process.env.WORKER_CONTAINER_NAME || "worker"));
    const exitCode = worker?.exitCode;
    const stopReason = [task?.stopCode, task?.stoppedReason, worker?.reason].filter(Boolean).join("; ").slice(0, 2000);
    const reason = cancelled ? "CANCELLED" : metadata.deadlineStopRequestedAt ? "DEADLINE_EXCEEDED"
      : exitCode === 0 && task?.stopCode !== "TaskFailedToStart" && !/outofmemory/i.test(stopReason) ? "OUTPUT_MISSING" : "TASK_FAILED";
    const message = reason === "CANCELLED" ? "Job cancelled." : reason === "DEADLINE_EXCEEDED" ? "Execution deadline exceeded."
      : reason === "TASK_FAILED" ? `AWS worker task stopped unexpectedly${typeof exitCode === "number" ? ` (exit ${exitCode})` : ""}${stopReason ? `: ${stopReason}` : "."}`
        : "Worker task stopped without a finalized row result for every claim.";
    const finalization: WorkerResultFinalization = { clientSystem: current.clientSystem!,
      taskArn: confirmation.kind === "stopped" ? confirmation.taskArn : undefined, exitCode, reason, errorMessage: message };
    const beforeLaunch = confirmation.kind === "before-launch";
    const [snapshot, artifacts, discovered] = beforeLaunch ? [null, [], []] : await Promise.all([
      eligibility ? null : deps.snapshot(current, expectedRefs), deps.artifacts(current.jobId), deps.discover(current),
    ]);
    const recovered = new Map((snapshot?.summary?.row_results ?? []).filter(row => row.status !== "INCOMPLETE")
      .map(row => [row.client_row_ref, row]));
    let artifact = snapshot?.artifact ?? metadata.workerResultState?.artifact ?? null;
    const candidates = [artifact, ...artifacts.filter(item => item.bucket && item.s3Key && item.filename.endsWith(".xlsx")
      && ["output_snapshot", "file_download"].includes(item.artifactType)).map(item => ({
      bucket: item.bucket!, object_key: item.s3Key, filename: item.filename, artifact_type: "output_snapshot" as const,
      size_bytes: 0, etag: null,
    })), ...discovered].filter((item): item is ServiceWorkbookArtifact => Boolean(item));
    const eligibilityFiles = eligibilityServiceOutputFilenames(current.portalId);
    if (eligibility) candidates.sort((a, b) => Number(b.filename !== `${current.portalId}-eligibility-partial-output.xlsx`)
      - Number(a.filename !== `${current.portalId}-eligibility-partial-output.xlsx`));
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (eligibility && !eligibilityFiles.includes(candidate.filename)) continue;
      const key = `${candidate.bucket}/${candidate.object_key}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const bytes = await deps.workbook(candidate);
      if (!bytes) continue; // Confirmed missing object; existing DB/JSON outcomes still survive.
      // Stop-only recovery uses each workflow's existing result meanings.
      const rows = eligibility ? (await normalizeEligibilityServiceWorkbook(bytes, expectedRefs,
        { requireStatusColumns: false, unfinishedAsPending: true, portal: current.portalId })).row_results.filter(row => row.status !== "INCOMPLETE")
        : await completedWorkerWorkbookResults(bytes, expectedRefs);
      for (const row of rows) {
        if (!recovered.has(row.client_row_ref)) recovered.set(row.client_row_ref, row);
      }
      if (!artifact || artifact.object_key === candidate.object_key) artifact = { ...candidate, size_bytes: bytes.length };
    }
    if (eligibility) {
      await (deps.publishEligibility ?? publishServiceResultPage)({ jobId: current.jobId, expectedRefs,
        summary: summarizeServiceResults([...recovered.values()]), cursor: 0, limit: 1,
        workerState: { artifact, finalized: true }, finalization,
        terminalStatus: cancelled ? "cancelled" : "failed", terminalFailure: { category: reason, message },
      });
    } else {
      const publisher = createClaimResultPublisher({ jobId: current.jobId, expectedRefs,
        initial: { version: 1, producer: "claim-status-worker", job_id: current.jobId,
          finalized: false, results: [...recovered.values()], artifact },
        save: async manifest => { await deps.publish(current, expectedRefs, manifest, finalization); },
      });
      await publisher.finish(reason, reason === "CANCELLED" || reason === "OUTPUT_MISSING" ? undefined : message);
    }
    const saved = await deps.find(current.jobId);
    if (!saved) throw new Error("Finalized job could not be read.");
    await (cancelled ? deps.notify(current.jobId) : deps.notifyStopped(saved)).catch(() => {});
    return saved;
  } catch (error) {
    if (error instanceof ServicePublicationError) throw error;
    throw new ServicePublicationError(503, "Stopped job results could not be recovered or saved; reconciliation will retry.");
  }
}
