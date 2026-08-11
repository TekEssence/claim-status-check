import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { jsonResponse, parseJsonBody, getAuthUserId, getJobId, createJobId, type ApiEvent } from "../runtime/http";
import { describeWorkerTask, runWorkerTask, stopWorkerTask } from "../runtime/ecs";
import { buildWorkflowKey, createDownloadUrl, createUploadUrl } from "../runtime/s3";
import {
  appendWorkflowEvent,
  createWorkflowCommand,
  createWorkflowJob,
  getWorkflowJobForUser,
  listArtifactsForJob,
  listWorkflowJobsForUser,
  listWorkflowEvents,
  updateWorkflowJob,
} from "../runtime/workflow-db";

type CreateJobBody = {
  portalId?: string;
  files?: Array<{ field: string; filename: string; contentType?: string }>;
  formFields?: Record<string, unknown>;
};

const uploadFields = new Set(["claimExcel", "loginExcel", "inputExcel", "credentialExcel", "claimRows"]);
let s3Client: S3Client | null = null;
const activeJobStatuses = new Set(["queued", "running", "waiting_otp"]);

function s3(): S3Client {
  if (!s3Client) s3Client = new S3Client({});
  return s3Client;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured.`);
  return value;
}

function workflowId() {
  return "claim-status";
}

function isActiveJobStatus(status: string): boolean {
  return activeJobStatuses.has(status);
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
    const status = exitCode === 0 ? "completed" : "failed";
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
    const userId = getAuthUserId(event);
    const body = parseJsonBody<CreateJobBody>(event);
    const portalId = body.portalId?.trim() || "iehp";
    const jobId = createJobId();
    const inputBucket = required("WORKFLOW_INPUTS_BUCKET");
    const outputBucket = required("WORKFLOW_OUTPUTS_BUCKET");
    const inputPrefix = `${workflowId()}/${new Date().toISOString().slice(0, 10)}/${jobId}/input`;
    const outputPrefix = `${workflowId()}/${new Date().toISOString().slice(0, 10)}/${jobId}/output`;
    const uploads: Array<{ field: string; filename: string; key: string; uploadUrl: string }> = [];
    const inputKeys: Record<string, string> = {};

    for (const file of body.files ?? []) {
      if (!uploadFields.has(file.field)) continue;
      const key = buildWorkflowKey({
        workflowId: workflowId(),
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
      workflowId: workflowId(),
      portalId,
      inputBucket,
      outputBucket,
      inputPrefix,
      outputPrefix,
      claimFileName: body.files?.find((file) => file.field === "claimExcel" || file.field === "inputExcel")?.filename,
      loginFileName: body.files?.find((file) => file.field === "loginExcel" || file.field === "credentialExcel")?.filename,
      metadata: { inputKeys, formFields: body.formFields ?? {} },
    });
    await appendWorkflowEvent(jobId, "job_created", { type: "job_started", portalId });

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
      portalId: job.portalId,
      inputBucket: job.inputBucket || required("WORKFLOW_INPUTS_BUCKET"),
      outputBucket: job.outputBucket || required("WORKFLOW_OUTPUTS_BUCKET"),
      inputKeys: metadata.inputKeys ?? {},
      formFields: metadata.formFields ?? {},
    });
    await updateWorkflowJob({ jobId, status: "running", ecsTaskArn: taskArn });
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
    const job = await reconcileAwsJobRuntime(await getWorkflowJobForUser(jobId, userId));
    if (!job) return jsonResponse(404, { error: "Job not found." });
    const events = await listWorkflowEvents(jobId, Number(event.queryStringParameters?.after || 0));
    const artifacts = await listArtifactsForJob(jobId);
    return jsonResponse(200, { job, events, artifacts });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to load job." });
  }
}

export async function listJobs(event: ApiEvent) {
  try {
    const userId = getAuthUserId(event);
    const rawLimit = Number(event.queryStringParameters?.limit || 25);
    const jobs = await reconcileAwsJobsRuntime(await listWorkflowJobsForUser(userId, Number.isFinite(rawLimit) ? rawLimit : 25));
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
  try {
    const userId = getAuthUserId(event);
    const jobId = getJobId(event);
    const job = await getWorkflowJobForUser(jobId, userId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    const body = parseJsonBody<{ otp?: string; inputName?: string }>(event);
    const otp = body.otp?.trim();
    if (!otp) return jsonResponse(400, { error: "Missing OTP." });
    await createWorkflowCommand({
      jobId,
      commandType: body.inputName || "otp",
      payload: { value: otp },
      createdBy: userId,
      ttlMs: 2 * 60 * 1000,
    });
    await appendWorkflowEvent(jobId, "otp_submitted", { type: "otp_submitted" });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to submit OTP." });
  }
}

export async function cancelJob(event: ApiEvent) {
  try {
    const userId = getAuthUserId(event);
    const jobId = getJobId(event);
    const job = await getWorkflowJobForUser(jobId, userId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    await createWorkflowCommand({ jobId, commandType: "cancel", createdBy: userId });
    await updateWorkflowJob({ jobId, status: "cancelled" });
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
    const job = await getWorkflowJobForUser(jobId, userId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    if (!job.ecsTaskArn) return jsonResponse(409, { error: "Job does not have an ECS task ARN." });
    await stopWorkerTask(job.ecsTaskArn, body.reason || `Force-stopped by ${userId}`);
    await updateWorkflowJob({ jobId, status: "cancelled" });
    await appendWorkflowEvent(jobId, "force_stopped", { type: "cancellation_acknowledged" });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to force stop job." });
  }
}

export async function downloadJob(event: ApiEvent) {
  try {
    const userId = getAuthUserId(event);
    const jobId = getJobId(event);
    const job = await getWorkflowJobForUser(jobId, userId);
    if (!job) return jsonResponse(404, { error: "Job not found." });
    const artifacts = await listArtifactsForJob(jobId);
    const artifact = artifacts.find((item) => item.artifactType === "output_snapshot" || item.artifactType === "file_download") ?? artifacts[0];
    if (!artifact) return jsonResponse(404, { error: "No output is available yet." });
    if (!artifact.bucket) return jsonResponse(500, { error: "Output artifact is missing its S3 bucket." });
    const downloadUrl = await createDownloadUrl({ bucket: artifact.bucket, key: artifact.s3Key });
    return jsonResponse(200, { filename: artifact.filename, downloadUrl });
  } catch (error) {
    return jsonResponse(500, { error: error instanceof Error ? error.message : "Failed to create download URL." });
  }
}

export async function putClaimRowsJson(bucket: string, key: string, value: unknown) {
  await s3().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(value),
    ContentType: "application/json",
  }));
}
