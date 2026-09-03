import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { WORKFLOW_IDS, type WorkflowId } from "@/backend/src/workflows/types";
import { jsonResponse, parseJsonBody, getAuthUserId, getAuthUserSnapshot, getJobId, createJobId, hasFullWorkflowAccess, type ApiEvent } from "../runtime/http";
import { describeWorkerTask, runWorkerTask, stopWorkerTask } from "../runtime/ecs";
import { buildWorkflowKey, createDownloadUrl, createUploadUrl } from "../runtime/s3";
import {
  appendWorkflowEvent,
  createWorkflowCommand,
  createWorkflowJob,
  getWorkflowJobForUser,
  getWorkflowJobById,
  listArtifactsForJob,
  listRunningWorkflowJobs,
  listWorkflowJobsForUser,
  listWorkflowEvents,
  updateWorkflowJob,
} from "../runtime/workflow-db";

type CreateJobBody = {
  workflowId?: string;
  portalId?: string;
  files?: Array<{ field: string; filename: string; contentType?: string }>;
  formFields?: Record<string, unknown>;
};

const uploadFields = new Set(["claimExcel", "loginExcel", "inputExcel", "credentialExcel", "inputFile", "credentialFile", "referenceExcel", "claimRows"]);
let s3Client: S3Client | null = null;
let cloudWatchLogsClient: CloudWatchLogsClient | null = null;
const activeJobStatuses = new Set(["queued", "running", "waiting_otp", "cancelling"]);

function s3(): S3Client {
  if (!s3Client) s3Client = new S3Client({});
  return s3Client;
}

function cloudWatchLogs(): CloudWatchLogsClient {
  if (!cloudWatchLogsClient) cloudWatchLogsClient = new CloudWatchLogsClient({});
  return cloudWatchLogsClient;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function normalizeWorkflowId(value: string | undefined): WorkflowId {
  return (WORKFLOW_IDS as readonly string[]).includes(value || "") ? value as WorkflowId : "claim-status";
}

function isActiveJobStatus(status: string): boolean {
  return activeJobStatuses.has(status);
}

function optional(name: string): string {
  return process.env[name]?.trim() || "";
}

function parseCloudWatchJobLog(jobId: string, message: string | undefined): string | null {
  const raw = String(message || "").trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { jobId?: unknown; message?: unknown };
    if (parsed.jobId !== jobId) return null;
    return typeof parsed.message === "string" && parsed.message.trim() ? parsed.message.trim() : null;
  } catch {
    return raw.includes(jobId) ? raw : null;
  }
}

async function listCloudWatchJobLogs(job: Awaited<ReturnType<typeof getWorkflowJobById>>): Promise<string[]> {
  if (!job) return [];
  const logGroupName = optional("WORKER_LOG_GROUP");
  if (!logGroupName) return [];
  const startMs = Date.parse(String(job.startedAt || job.createdAt || ""));
  const endMs = Date.parse(String(job.finishedAt || job.updatedAt || ""));
  const result = await cloudWatchLogs().send(new FilterLogEventsCommand({
    logGroupName,
    filterPattern: `"${job.jobId}"`,
    startTime: Number.isFinite(startMs) ? Math.max(0, startMs - 5 * 60 * 1000) : undefined,
    endTime: Number.isFinite(endMs) ? endMs + 5 * 60 * 1000 : undefined,
    limit: 200,
  }));
  return (result.events ?? [])
    .sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
    .map((event) => parseCloudWatchJobLog(job.jobId, event.message))
    .filter((line): line is string => Boolean(line));
}

async function reconcileAwsJobRuntime(job: Awaited<ReturnType<typeof getWorkflowJobForUser>>) {
  if (!job || !isActiveJobStatus(job.status)) return job;

  const updatedAtMs = Date.parse(String(job.updatedAt));
  const ageMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : 0;
  if (!job.ecsTaskArn) {
    if ((job.status === "queued" || job.status === "running") && ageMs > 15 * 60 * 1000) {
      const message = "AWS worker task was not started or no longer exists for this job.";
      await updateWorkflowJob({ jobId: job.jobId, status: "failed", errorMessage: message });
      await appendWorkflowEvent(job.jobId, "failed", { type: "failed", message }).catch(() => {});
      return { ...job, status: "failed", errorMessage: message, finishedAt: new Date().toISOString() };
    }
    return job;
  }

  const task = await describeWorkerTask(job.ecsTaskArn).catch(() => null);
  if (!task) return job;
  if (task.lastStatus === "STOPPED") {
    const stoppedReason = task.stoppedReason || task.containers?.find((container) => container.reason)?.reason || "";
    const exitCode = task.containers?.find((container) => typeof container.exitCode === "number")?.exitCode;
    const status = job.status === "cancelling" ? "cancelled" : exitCode === 0 ? "completed" : "failed";
    const message = status === "completed"
      ? undefined
      : stoppedReason || `AWS worker task stopped${typeof exitCode === "number" ? ` with exit code ${exitCode}` : ""}.`;
    await updateWorkflowJob({ jobId: job.jobId, status, errorMessage: message });
    await appendWorkflowEvent(job.jobId, status, { type: status, ...(message ? { message } : {}) }).catch(() => {});
    return {
      ...job,
      status,
      errorMessage: message ?? job.errorMessage,
      finishedAt: new Date().toISOString(),
    };
  }

  return job;
}

async function reconcileAwsJobsRuntime<T extends Awaited<ReturnType<typeof listWorkflowJobsForUser>>[number]>(jobs: T[]) {
  return Promise.all(jobs.map((job) => reconcileAwsJobRuntime(job)));
}

export async function createJob(event: ApiEvent) {
  try {
    const user = getAuthUserSnapshot(event);
    const userId = user.userId;
    const body = parseJsonBody<CreateJobBody>(event);
    const workflowId = normalizeWorkflowId(body.workflowId);
    const portalId = body.portalId?.trim() || "iehp";
    const jobId = createJobId();
    const inputBucket = required("WORKFLOW_INPUTS_BUCKET");
    const outputBucket = required("WORKFLOW_OUTPUTS_BUCKET");
    const inputPrefix = `${workflowId}/${new Date().toISOString().slice(0, 10)}/${jobId}/input`;
    const outputPrefix = `${workflowId}/${new Date().toISOString().slice(0, 10)}/${jobId}/output`;
    const uploads: Array<{ field: string; filename: string; key: string; uploadUrl: string }> = [];
    const inputKeys: Record<string, string> = {};

    for (const file of body.files ?? []) {
      if (!uploadFields.has(file.field)) continue;
      const key = buildWorkflowKey({
        workflowId,
        jobId,
        area: "input",
        filename: `${file.field}-${file.filename}`,
      });
      inputKeys[file.field] = key;
      uploads.push({
        field: file.field,
        filename: file.filename,
        key,
        uploadUrl: await createUploadUrl({ bucket: inputBucket, key, contentType: file.contentType }),
      });
    }

    await createWorkflowJob({
      jobId,
      userId,
      workflowId,
      portalId,
      inputBucket,
      outputBucket,
      inputPrefix,
      outputPrefix,
      claimFileName: body.files?.find((file) => file.field === "claimExcel" || file.field === "inputExcel" || file.field === "inputFile" || file.field === "referenceExcel")?.filename,
      loginFileName: body.files?.find((file) => file.field === "loginExcel" || file.field === "credentialExcel" || file.field === "credentialFile")?.filename,
      createdByUserId: user.userId,
      createdByEmail: user.email,
      createdByName: user.name,
      metadata: { inputKeys, formFields: body.formFields ?? {} },
    });
    await appendWorkflowEvent(jobId, "job_created", { type: "job_started", workflowId, portalId });

    return jsonResponse(200, { jobId, uploads });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to create job." });
  }
}

export async function confirmJob(event: ApiEvent) {
  let jobId = "";
  try {
    const userId = getAuthUserId(event);
    jobId = getJobId(event);
    const job = await getWorkflowJobForUser(jobId, userId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    if (job.status !== "queued") return jsonResponse(409, { error: `Job is already ${job.status}.` });

    const metadata = job.metadata as { inputKeys?: Record<string, string>; formFields?: Record<string, unknown> };
    const taskArn = await runWorkerTask({
      jobId,
      userId,
      workflowId: job.workflowId,
      portalId: job.portalId,
      inputBucket: job.inputBucket || required("WORKFLOW_INPUTS_BUCKET"),
      outputBucket: job.outputBucket || required("WORKFLOW_OUTPUTS_BUCKET"),
      inputKeys: metadata.inputKeys ?? {},
      formFields: metadata.formFields ?? {},
    });
    await updateWorkflowJob({ jobId, status: "running", ecsTaskArn: taskArn, startedAt: new Date().toISOString() });
    await appendWorkflowEvent(jobId, "task_started", { type: "task_starting", taskArn });
    return jsonResponse(200, { jobId, taskArn });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start job.";
    if (jobId) {
      await updateWorkflowJob({ jobId, status: "failed", errorMessage: message });
      await appendWorkflowEvent(jobId, "task_start_failed", { type: "failed", message });
    }
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to start job." });
  }
}

export async function getJob(event: ApiEvent) {
  try {
    const userId = getAuthUserId(event);
    const jobId = getJobId(event);
    const job = await reconcileAwsJobRuntime(hasFullWorkflowAccess(event) ? await getWorkflowJobById(jobId) : await getWorkflowJobForUser(jobId, userId));
    if (!job) return jsonResponse(404, { error: "Job not found." });
    const events = await listWorkflowEvents(jobId, Number(event.queryStringParameters?.after || 0));
    const artifacts = await listArtifactsForJob(jobId);
    const logs = event.queryStringParameters?.includeLogs === "true"
      ? await listCloudWatchJobLogs(job).catch(() => [])
      : undefined;
    return jsonResponse(200, { job, events, artifacts, logs });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to load job." });
  }
}

export async function listJobs(event: ApiEvent) {
  try {
    const userId = getAuthUserId(event);
    const rawLimit = Number(event.queryStringParameters?.limit || 25);
    const scope = event.queryStringParameters?.scope || "";
    const canSeeAll = scope === "all-running" && hasFullWorkflowAccess(event);
    const jobs = await reconcileAwsJobsRuntime(
      canSeeAll
        ? await listRunningWorkflowJobs(Number.isFinite(rawLimit) ? rawLimit : 50)
        : await listWorkflowJobsForUser(userId, Number.isFinite(rawLimit) ? rawLimit : 25),
    );
    const jobsWithArtifacts = await Promise.all(
      jobs.map(async (job) => {
        const artifacts = await listArtifactsForJob(job.jobId).catch(() => []);
        return {
          ...job,
          artifacts,
          artifactCount: artifacts.length,
        };
      }),
    );
    return jsonResponse(200, { jobs: jobsWithArtifacts });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to list jobs." });
  }
}

export async function submitOtp(event: ApiEvent) {
  let jobId = "";
  try {
    const userId = getAuthUserId(event);
    jobId = getJobId(event);
    const job = hasFullWorkflowAccess(event) ? await getWorkflowJobById(jobId) : await getWorkflowJobForUser(jobId, userId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    const body = parseJsonBody<{ otp?: unknown; value?: unknown; inputName?: unknown }>(event);
    const commandType = typeof body.inputName === "string" && body.inputName.trim()
      ? body.inputName.trim()
      : "otp";
    const inputValue = typeof body.otp === "string" && body.otp.trim()
      ? body.otp.trim()
      : typeof body.value === "string" && body.value.trim()
        ? body.value.trim()
        : "";
    if (!inputValue) return jsonResponse(400, { error: "Missing verification response." });
    await createWorkflowCommand({
      jobId,
      commandType,
      payload: { value: inputValue },
      createdBy: userId,
      ttlMs: 2 * 60 * 1000,
    });
    await appendWorkflowEvent(jobId, "input_submitted", { type: "input_submitted", inputName: commandType });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    console.error("Submit workflow input failed", {
      jobId,
      message: error instanceof Error ? error.message : String(error),
    });
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to submit verification response." });
  }
}

export async function cancelJob(event: ApiEvent) {
  try {
    const userId = getAuthUserId(event);
    const jobId = getJobId(event);
    const job = hasFullWorkflowAccess(event) ? await getWorkflowJobById(jobId) : await getWorkflowJobForUser(jobId, userId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    await createWorkflowCommand({ jobId, commandType: "cancel", createdBy: userId });
    const hasRunningWorker = Boolean(job.ecsTaskArn) && job.status !== "queued";
    await updateWorkflowJob({ jobId, status: hasRunningWorker ? "cancelling" : "cancelled" });
    await appendWorkflowEvent(jobId, "cancel_requested", { type: "cancellation_acknowledged" });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to cancel job." });
  }
}

export async function forceStopJob(event: ApiEvent) {
  try {
    const userId = getAuthUserId(event);
    const jobId = getJobId(event);
    const body = parseJsonBody<{ reason?: string }>(event);
    if (!hasFullWorkflowAccess(event)) return jsonResponse(403, { error: "Force stop requires admin or developer access." });
    const job = await getWorkflowJobById(jobId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    if (!job.ecsTaskArn) return jsonResponse(409, { error: "Job does not have an ECS task ARN." });
    const reason = body.reason || `Force-stopped by ${userId}`;
    await stopWorkerTask(job.ecsTaskArn, reason);
    await updateWorkflowJob({ jobId, status: "cancelled" });
    await appendWorkflowEvent(jobId, "force_stopped", { type: "cancellation_acknowledged", initiatedBy: userId, reason });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to force stop job." });
  }
}

export async function downloadJob(event: ApiEvent) {
  try {
    const userId = getAuthUserId(event);
    const jobId = getJobId(event);
    const job = hasFullWorkflowAccess(event) ? await getWorkflowJobById(jobId) : await getWorkflowJobForUser(jobId, userId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    const artifacts = await listArtifactsForJob(jobId);
    const paymentEobZip = job.workflowId === "payment-eob-download"
      ? artifacts.find((item) => item.artifactType === "file_download" && isZipArtifact(item.filename, item.mimeType))
      : undefined;
    const artifact = paymentEobZip
      ?? artifacts.find((item) => item.artifactType === "file_download" && isPreferredOutputArtifact(item.filename, item.mimeType))
      ?? artifacts.find((item) => item.artifactType === "file_download" && isDownloadableNonDiagnosticArtifact(item.filename, item.mimeType))
      ?? artifacts.find((item) => item.artifactType === "output_snapshot");
    if (!artifact) return jsonResponse(404, { error: "No output is available yet." });
    if (!artifact.bucket) return jsonResponse(500, { error: "Output artifact is missing its S3 bucket." });
    const downloadUrl = await createDownloadUrl({
      bucket: artifact.bucket,
      key: artifact.s3Key,
      filename: artifact.filename,
      contentType: artifact.mimeType,
    });
    return jsonResponse(200, { filename: artifact.filename, downloadUrl });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to create download URL." });
  }
}

function isZipArtifact(filename: string, mimeType?: string | null): boolean {
  return filename.toLowerCase().endsWith(".zip") || (mimeType || "").toLowerCase() === "application/zip";
}

function isPreferredOutputArtifact(filename: string, mimeType?: string | null): boolean {
  const normalizedFilename = filename.toLowerCase();
  const normalizedMimeType = (mimeType || "").toLowerCase();
  return (
    normalizedFilename.endsWith(".xlsx") ||
    normalizedFilename.endsWith(".xls") ||
    normalizedMimeType.includes("spreadsheet")
  );
}

function isDownloadableNonDiagnosticArtifact(filename: string, mimeType?: string | null): boolean {
  const normalizedFilename = filename.toLowerCase();
  const normalizedMimeType = (mimeType || "").toLowerCase();
  if (normalizedFilename.endsWith(".pdf") || normalizedMimeType === "application/pdf") return false;
  if (normalizedFilename.endsWith(".log") || normalizedFilename.endsWith(".txt") || normalizedMimeType.startsWith("text/")) return false;
  if (normalizedFilename.endsWith(".html") || normalizedMimeType === "text/html") return false;
  return true;
}

export async function putClaimRowsJson(bucket: string, key: string, value: unknown) {
  await s3().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
  }));
}
