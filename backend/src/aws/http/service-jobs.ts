import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { authenticateService, authenticateServiceWithToken, ServiceAuthError } from "../runtime/service-auth";
import { buildWorkflowKey, createDownloadUrl } from "../runtime/s3";
import { jsonResponse, parseJsonBody, createJobId, type ApiEvent } from "../runtime/http";
import {
  appendWorkflowEvent, createWorkflowCommand, createWorkflowJob, getLatestWorkflowInputRequest,
  getWorkflowJobByClientKey, getWorkflowJobById, listArtifactsForJob, markWorkflowJobReady,
  updateWorkflowJob,
} from "../runtime/workflow-db";
import { cancelIntegratedWorkflowJob, launchQueuedWorkflowJob, reconcileAwsJobRuntime } from "./jobs";
import { pageServiceResults } from "../service/iehp-results";
import { getServiceWorkflowForJob, loadIntegratedServiceSnapshot, resolveServiceWorkflowRoute, ServiceWorkflowDispatchError } from "../service/workflow-registry";
import { lookupServiceSubmission, reserveServiceSubmission, ServiceSubmissionConflict } from "../service/service-submission";
import { ServiceCancellationConflict } from "../service/service-cancellation";
import type { ServiceSubmitBody } from "../service/service-contract";

class ServiceRequestError extends Error {
  constructor(public readonly statusCode: number, message: string) { super(message); }
}

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client({});
  return client;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new ServiceRequestError(503, `${name} is not configured.`);
  return value;
}

function requiredId(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160) {
    throw new ServiceRequestError(400, `${name} must be a non-empty string of at most 160 characters.`);
  }
  return value.trim();
}

function requiredDeadline(value: unknown): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw new ServiceRequestError(400, "deadline_at must be an ISO 8601 timestamp with a timezone.");
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < Date.now() + 60_000 || parsed > Date.now() + 7 * 24 * 60 * 60 * 1000) {
    throw new ServiceRequestError(400, "deadline_at must be between 1 minute and 7 days in the future.");
  }
  return new Date(parsed).toISOString();
}

function errorResponse(error: unknown) {
  if (hasPostgresCode(error, "42703")) {
    return jsonResponse(503, { error: "Claim Status service database migration 0007 has not been applied." });
  }
  const status = error instanceof ServiceAuthError || error instanceof ServiceRequestError || error instanceof ServiceWorkflowDispatchError ? error.statusCode
    : error instanceof ServiceSubmissionConflict ? 409
      : error instanceof ServiceCancellationConflict ? 503 : error instanceof SyntaxError ? 400 : 500;
  const message = error instanceof Error ? error.message : "Claim Status service request failed.";
  return jsonResponse(status, { error: status === 500 ? "Claim Status service request failed." : message });
}

function hasPostgresCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 3 && current && typeof current === "object"; depth += 1) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

async function putWithRetry(bucket: string, key: string, body: Buffer | string, contentType: string): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await s3().send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "AES256",
      }));
      const saved = await s3().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      if (!saved.ContentLength) throw new Error(`S3 input ${key} is empty.`);
      return;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1)));
    }
  }
}

function statusName(status: string): string {
  return status === "completed" ? "SUCCESS" : status === "partial_success" ? "PARTIAL_SUCCESS" : status.toUpperCase();
}

function errorCategory(message: string | null, status: string): string | null {
  if (status === "waiting_otp") return "OTP_REQUIRED";
  if (!message) return null;
  if (/deadline exceeded/i.test(message)) return "DEADLINE_EXCEEDED";
  if (/otp|mfa|captcha|verification required|action required/i.test(message)) return "MANUAL_ACTION_REQUIRED";
  if (/credential|login failed|password|sign.in/i.test(message)) return "AUTH_FAILED";
  if (/output workbook|row result|output artifact/i.test(message)) return /missing|without|not saved|unavailable/i.test(message) ? "OUTPUT_MISSING" : "OUTPUT_INVALID";
  if (/input upload|s3 input/i.test(message)) return "RETRYABLE_INFRA";
  if (/run.?task|ecs|worker task|task stopped/i.test(message)) return "TASK_FAILED";
  if (/unavailable|maintenance/i.test(message)) return "PORTAL_UNAVAILABLE";
  return "PORTAL_ERROR";
}

async function ownedJob(event: ApiEvent, reconcile = true) {
  const clientSystem = authenticateService(event);
  const jobId = event.pathParameters?.jobId?.trim();
  if (!jobId) throw new ServiceRequestError(400, "Missing jobId.");
  const job = await getWorkflowJobById(jobId);
  if (!job || job.clientSystem !== clientSystem) throw new ServiceRequestError(404, "Job not found.");
  return reconcile ? await reconcileAwsJobRuntime(job) ?? job : job;
}

export async function submitServiceJob(event: ApiEvent) {
  try {
    const { clientSystem, token } = authenticateServiceWithToken(event);
    const body = parseJsonBody<ServiceSubmitBody>(event);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ServiceRequestError(400, "Request body must be an object.");
    if (body.client_system !== clientSystem) throw new ServiceRequestError(400, "client_system must match X-Client-System.");
    const clientExecutionId = requiredId(body.client_execution_id, "client_execution_id");
    const idempotencyKey = requiredId(body.idempotency_key, "idempotency_key");
    const reservation = await reserveServiceSubmission({
      clientSystem, clientExecutionId, idempotencyKey,
      portalId: typeof body.portal === "string" ? body.portal : "",
      body: body as Record<string, unknown>, authenticatedToken: token,
      find: getWorkflowJobByClientKey,
      prepare: async () => {
        const { workflow, portalId, adapter } = resolveServiceWorkflowRoute(body.workflow, body.portal);
        const deadlineAt = requiredDeadline(body.deadline_at);
        try {
          return { workflow, portalId, deadlineAt, generated: await adapter.prepare(body) };
        } catch (error) {
          throw new ServiceRequestError(422, error instanceof Error ? error.message : "Invalid portal claim input.");
        }
      },
      createJobId,
      isUniqueViolation: (error) => hasPostgresCode(error, "23505"),
      create: async (jobId, prepared, fingerprint, salt) => {
        const { workflow, portalId, deadlineAt, generated } = prepared;
        const inputBucket = requiredEnv("WORKFLOW_INPUTS_BUCKET");
        const outputBucket = requiredEnv("WORKFLOW_OUTPUTS_BUCKET");
        const inputKeys: Record<string, string> = Object.fromEntries(generated.files.map((file) => [
          file.field,
          buildWorkflowKey({ workflowId: workflow.runnerWorkflowId, jobId, area: "input", filename: `${file.field}-${file.filename}` }),
        ]));
        inputKeys.claimRows = buildWorkflowKey({ workflowId: workflow.runnerWorkflowId, jobId, area: "input", filename: "claimRows.json" });
        await createWorkflowJob({
          jobId, userId: `service:${clientSystem}`, workflowId: workflow.runnerWorkflowId, portalId,
          clientSystem, clientExecutionId, idempotencyKey, initialStatus: "preparing",
          inputBucket, outputBucket,
          inputPrefix: inputKeys.claimRows.slice(0, inputKeys.claimRows.lastIndexOf("/")),
          outputPrefix: inputKeys.claimRows.slice(0, inputKeys.claimRows.lastIndexOf("/")).replace(/\/input$/, "/output"),
          claimFileName: generated.claimFileName, loginFileName: generated.loginFileName,
          createdByUserId: `service:${clientSystem}`, createdByEmail: "service", createdByName: clientSystem,
          metadata: {
            integrationMode: "service", requestHash: fingerprint, requestHashVersion: 3, requestHashSalt: salt,
            deadlineAt, expectedRowCount: generated.claimCount, inputKeys,
            accountLabel: generated.accountLabel, formFields: generated.formFields,
          },
        });
      },
    });
    if (reservation.existing) {
      return jsonResponse(200, { job_id: reservation.job.jobId, status: statusName(reservation.job.status), existing: true });
    }
    const { jobId, prepared: { generated } } = reservation;
    const saved = await getWorkflowJobById(jobId);
    if (!saved) throw new ServiceRequestError(503, "Accepted job was not found after creation; retry with the same idempotency key.");
    const inputBucket = saved.inputBucket || requiredEnv("WORKFLOW_INPUTS_BUCKET");
    const inputKeys = (saved.metadata as { inputKeys: Record<string, string> }).inputKeys;

    try {
      for (const file of generated.files) {
        await putWithRetry(inputBucket, inputKeys[file.field], file.buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      }
      await putWithRetry(inputBucket, inputKeys.claimRows, generated.claimRowsJson, "application/json");
      if (!await markWorkflowJobReady(jobId)) throw new Error("Job was not in the preparing state after input upload.");
      await appendWorkflowEvent(jobId, "inputs_ready", { type: "log", message: `Integrated ${reservation.prepared.workflow.resultLabel} inputs are ready.` });
      await launchQueuedWorkflowJob(jobId, `service:${clientSystem}`);
    } catch (error) {
      const current = await getWorkflowJobById(jobId);
      if (current?.status === "preparing") {
        await updateWorkflowJob({ jobId, status: "failed", errorMessage: "Integrated input upload failed." });
        await appendWorkflowEvent(jobId, "input_upload_failed", { type: "failed", message: "Integrated input upload failed." }).catch(() => {});
      }
      console.error("Integrated Claim Status submission failed", { jobId, stage: current?.status, errorName: error instanceof Error ? error.name : "unknown" });
      return jsonResponse(503, {
        job_id: jobId,
        status: current ? statusName(current.status) : "UNKNOWN",
        error: current?.status === "preparing" || current?.status === "failed"
          ? "Claim Status submission failed. Inspect the job before retrying with a new idempotency key."
          : "Claim Status launch state is uncertain. Poll this job before retrying; the worker may already be running.",
      });
    }
    const current = await getWorkflowJobById(jobId);
    return jsonResponse(202, { job_id: jobId, status: current ? statusName(current.status) : "RUNNING", existing: false });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function lookupServiceJob(event: ApiEvent) {
  try {
    const clientSystem = authenticateService(event);
    const clientExecutionId = requiredId(event.queryStringParameters?.client_execution_id, "client_execution_id");
    const idempotencyKey = requiredId(event.queryStringParameters?.idempotency_key, "idempotency_key");
    const lookup = await lookupServiceSubmission({
      clientSystem, clientExecutionId, idempotencyKey,
      find: getWorkflowJobByClientKey,
    });
    if (!lookup.found) return jsonResponse(200, { found: false });
    const current = lookup.job;
    return jsonResponse(200, {
      found: true, job_id: current.jobId, status: statusName(current.status),
      client_execution_id: current.clientExecutionId, idempotency_key: idempotencyKey,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function cancelServiceJob(event: ApiEvent) {
  try {
    const job = await ownedJob(event, false);
    const result = await cancelIntegratedWorkflowJob(job.jobId, job.clientSystem!, `service:${job.clientSystem}`);
    return jsonResponse(200, { job_id: result.jobId, status: statusName(result.status), terminal: result.terminal });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function getServiceJobResult(event: ApiEvent) {
  try {
    const job = await ownedJob(event);
    const resultLabel = getServiceWorkflowForJob(job.workflowId)?.resultLabel ?? "Claim Status";
    const rawCursor = event.queryStringParameters?.cursor ?? "0";
    const rawLimit = event.queryStringParameters?.limit ?? "100";
    if (!/^(0|[1-9]\d*)$/.test(rawCursor) || !/^[1-9]\d*$/.test(rawLimit)) {
      throw new ServiceRequestError(400, "cursor must be a nonnegative integer and limit must be a positive integer.");
    }
    const cursor = Number(rawCursor);
    const limit = Number(rawLimit);
    if (!Number.isSafeInteger(cursor) || !Number.isSafeInteger(limit) || limit > 200) {
      throw new ServiceRequestError(400, "cursor must be a safe integer and limit must be at most 200.");
    }
    const terminal = ["completed", "partial_success", "failed", "cancelled"].includes(job.status);
    let snapshot: Awaited<ReturnType<typeof loadIntegratedServiceSnapshot>> | null = null;
    let total = 0;
    try {
      snapshot = await loadIntegratedServiceSnapshot(job, { requireStatusColumns: false });
      total = snapshot.expectedRefs.length;
    } catch {
      const artifacts = await listArtifactsForJob(job.jobId);
      const noOutput = !artifacts.some((item) => item.artifactType === "output_snapshot" || (item.artifactType === "file_download" && item.filename.endsWith(".xlsx")));
      const expectedRowCount = (job.metadata as { expectedRowCount?: unknown } | null)?.expectedRowCount;
      if (!terminal || !["failed", "cancelled"].includes(job.status) || !noOutput || typeof expectedRowCount !== "number") {
        throw new ServiceRequestError(503, `Current ${resultLabel} workbook is unavailable or invalid; retry this poll.`);
      }
      total = expectedRowCount;
    }
    const summary = snapshot?.summary ?? null;
    const artifact = snapshot?.artifact ?? null;
    if (cursor > total) throw new ServiceRequestError(400, "cursor exceeds the submitted claim count.");
    if ((job.status === "completed" || job.status === "partial_success") && (!summary || !artifact)) {
      throw new ServiceRequestError(503, `Final ${resultLabel} workbook is missing; retry this poll.`);
    }
    if (job.status === "completed" && summary?.outcome !== "SUCCESS") {
      throw new ServiceRequestError(503, `Final ${resultLabel} workbook does not match job status; retry this poll.`);
    }
    if (!summary && cursor > 0) throw new ServiceRequestError(503, `Previously visible ${resultLabel} workbook is unavailable; retry this poll.`);
    const { available, nextCursor, results } = pageServiceResults(summary, cursor, limit, terminal);
    if (cursor > available) throw new ServiceRequestError(503, `Previously finalized ${resultLabel} rows are unavailable; retry this poll.`);
    let actionRequired: Record<string, unknown> | null = null;
    if (job.status === "waiting_otp") {
      const challenge = await getLatestWorkflowInputRequest(job.jobId);
      const payload = challenge?.payload as { type?: unknown; inputName?: unknown; label?: unknown; message?: unknown; timeoutMs?: unknown;
        providerStage?: unknown; corporateTaxIdOwners?: unknown; careProviders?: unknown } | undefined;
      const timeoutMs = typeof payload?.timeoutMs === "number" && Number.isFinite(payload.timeoutMs) && payload.timeoutMs > 0
        ? payload.timeoutMs : null;
      actionRequired = {
        type: payload?.type === "provider_options" ? "PROVIDER_SELECTION_REQUIRED" : "OTP_REQUIRED", portal: job.portalId, job_id: job.jobId,
        input_name: typeof payload?.inputName === "string" ? payload.inputName : "otp",
        label: typeof payload?.label === "string" ? payload.label : "Verification code",
        message: typeof payload?.message === "string" ? payload.message : "Verification is required to continue.",
        expires_at: challenge && timeoutMs ? new Date(Date.parse(challenge.createdAt) + timeoutMs).toISOString() : null,
        account_label: typeof (job.metadata as { accountLabel?: unknown } | null)?.accountLabel === "string"
          ? (job.metadata as { accountLabel: string }).accountLabel : null,
        action_url: null,
        ...(payload?.type === "provider_options" ? {
          provider_stage: payload.providerStage,
          options: payload.providerStage === "care" ? payload.careProviders : payload.corporateTaxIdOwners,
        } : {}),
      };
    }
    const rowFailureCategory = job.status === "failed" && summary
      ? summary.counts.no_match === summary.counts.total ? "NO_MATCH"
        : summary.counts.action_required > 0 ? "MANUAL_ACTION_REQUIRED"
          : summary.counts.incomplete > 0 ? "INCOMPLETE" : null
      : null;
    return jsonResponse(200, {
      client_system: job.clientSystem, client_execution_id: job.clientExecutionId,
      job_id: job.jobId, portal: job.portalId, status: statusName(job.status),
      processed: summary?.finalized_count ?? 0, total,
      results,
      next_cursor: String(nextCursor), final: terminal && nextCursor === available,
      artifact,
      action_required: actionRequired,
      error_category: errorCategory(job.errorMessage, job.status) ?? rowFailureCategory,
      error: job.errorMessage || null,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function submitServiceJobInput(event: ApiEvent) {
  try {
    const job = await ownedJob(event);
    if (job.status !== "waiting_otp") throw new ServiceRequestError(409, "Job is not waiting for verification input.");
    const challenge = await getLatestWorkflowInputRequest(job.jobId);
    const payload = challenge?.payload as { inputName?: unknown } | undefined;
    const inputName = typeof payload?.inputName === "string" ? payload.inputName : "otp";
    const body = parseJsonBody<{ input_name?: unknown; value?: unknown }>(event);
    if (!body || typeof body !== "object" || Array.isArray(body) || body.input_name !== inputName || typeof body.value !== "string" || !body.value.trim() || body.value.length > 500) {
      throw new ServiceRequestError(400, "Invalid verification response.");
    }
    await createWorkflowCommand({ jobId: job.jobId, commandType: inputName, payload: { value: body.value.trim() }, createdBy: `service:${job.clientSystem}`, ttlMs: 2 * 60 * 1000 });
    await appendWorkflowEvent(job.jobId, "input_submitted", { type: "input_submitted", inputName });
    return jsonResponse(200, { ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function getServiceJobDownload(event: ApiEvent) {
  try {
    const job = await ownedJob(event);
    const artifacts = await listArtifactsForJob(job.jobId);
    const output = artifacts.find((item) => item.artifactType === "output_snapshot" && item.bucket && item.s3Key)
      ?? artifacts.find((item) => item.artifactType === "file_download" && item.bucket && item.s3Key && item.filename.endsWith(".xlsx"));
    if (!output?.bucket) throw new ServiceRequestError(404, "No output workbook is available yet.");
    const head = await s3().send(new HeadObjectCommand({ Bucket: output.bucket, Key: output.s3Key }));
    if (!head.ContentLength) throw new ServiceRequestError(404, "Output workbook is empty.");
    return jsonResponse(200, {
      filename: output.filename,
      download_url: await createDownloadUrl({ bucket: output.bucket, key: output.s3Key, filename: output.filename, contentType: output.mimeType }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
