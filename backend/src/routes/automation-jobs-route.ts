import {
  cancelScrapeJob,
  createScrapeJob,
  emitScrapeJobEvent,
  getScrapeJob,
  registerScrapeJobEmitListener,
  submitScrapeJobInput,
} from "@/backend/src/jobs/job-store";
import { getAutomationRunner } from "@/backend/src/workflows/registry";
import { isAutomationWorkflowId, type AutomationWorkflowId } from "@/backend/src/workflows/types";
import { getSessionFromCookies } from "@/lib/auth/session";
import { isAuthDbConnectionError } from "@/lib/auth/db";
import {
  appendAutomationJobArtifact,
  appendAutomationJobLog,
  createPersistentAutomationJob,
  getActiveAutomationJobForUser,
  getAutomationJobForUser,
  updateAutomationJob,
} from "@/lib/automation-jobs/db";
import { scheduleTaskShutdownAfterWorkflow } from "@/backend/src/core/task-shutdown";
import {
  uploadWorkflowArtifact,
  uploadWorkflowFile,
} from "@/backend/src/core/workflow-s3-storage";
import { getLastEventId, streamScrapeJobEvents } from "./scrape-jobs-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

let persistenceListenerRegistered = false;
const LOCAL_STALE_JOB_MS = 20 * 60 * 1000;

function ensurePersistenceListener() {
  if (persistenceListenerRegistered) return;
  persistenceListenerRegistered = true;
  registerScrapeJobEmitListener((jobId, event) => {
    const workflowId = getScrapeJob(jobId)?.workflowId;
    if (workflowId !== "eligibility-verification" && workflowId !== "payment-eob-download" && workflowId !== "payment-posting") return;
    void persistEvent(jobId, event);
  });
}

export async function POST(req: Request) {
  try {
    ensurePersistenceListener();
    const session = await getSessionFromCookies();
    if (!session) return Response.json({ error: "Authentication required." }, { status: 401 });

    const formData = await req.formData();
    const workflowId = getRequiredString(formData, "workflowId");
    const portalId = getRequiredString(formData, "portalId");
    const payerId = getOptionalString(formData, "payerId");
    if (!isAutomationWorkflowId(workflowId)) {
      return Response.json(
        { error: "Unsupported automation workflow." },
        { status: 400 },
      );
    }
    const automationWorkflowId: AutomationWorkflowId = workflowId;

    const activeJob = await getBlockingActiveAutomationJobForUser(session.userId);
    if (activeJob) {
      return Response.json(
        { error: "Another automation workflow run is active.", jobId: activeJob.jobId },
        { status: 409 },
      );
    }

    const runner = getAutomationRunner(automationWorkflowId, portalId, payerId);
    const input = runner.validateInput(formData);
    const job = createScrapeJob(undefined, automationWorkflowId);
    const inputFile = getFirstFile(formData, ["inputFile", "inputExcel", "referenceExcel"]);
    const credentialFile = getFirstFile(formData, ["credentialFile", "credentialExcel"]);
    await createPersistentAutomationJob({
      jobId: job.id,
      userId: session.userId,
      workflowId: automationWorkflowId,
      portalId,
      payerId,
      totalItems: getNumber(formData, "totalItems"),
      primaryInputFileName: inputFile?.name ?? "",
      credentialFileName: credentialFile?.name ?? "",
    });
    await uploadEligibilityInputs(job.id, inputFile, credentialFile).catch((error) => {
      console.error("Upload eligibility input files to S3 failed", error);
    });

    void runner.run(input, {
      jobId: job.id,
      workflowId: automationWorkflowId,
      portalId,
      payerId,
      emit: async (event) => emitScrapeJobEvent(job.id, event),
      log: async (event) => emitScrapeJobEvent(job.id, { type: "log", ...event }),
      isCancelled: () => {
        const current = getScrapeJob(job.id);
        return current?.cancelRequested === true || current?.status === "cancelled";
      },
    }).then(async () => {
      const current = getScrapeJob(job.id);
      const cancelled = current?.cancelRequested || current?.status === "cancelled";
      if (cancelled) {
        emitScrapeJobEvent(job.id, { type: "cancelled" });
        emitScrapeJobEvent(job.id, { type: "done" });
      } else {
        emitScrapeJobEvent(job.id, { type: "done" });
      }
      await updateAutomationJob({
        jobId: job.id,
        status: cancelled ? "cancelled" : "completed",
        currentCompleted: current?.currentCompleted ?? 0,
      }).catch(() => {});
      scheduleTaskShutdownAfterWorkflow(cancelled ? "eligibility-verification:cancelled" : "eligibility-verification:completed");
    }).catch(async (error) => {
      const message = error instanceof Error ? error.message : "Automation workflow failed.";
      emitScrapeJobEvent(job.id, { type: "error", message });
      emitScrapeJobEvent(job.id, { type: "done" });
      await updateAutomationJob({ jobId: job.id, status: "failed" }).catch(() => {});
      scheduleTaskShutdownAfterWorkflow("eligibility-verification:failed");
    });

    return Response.json({ jobId: job.id, workflowId: automationWorkflowId, portalId, payerId });
  } catch (error) {
    console.error("Start automation job failed", error);
    if (isAuthDbConnectionError(error)) {
      return Response.json(
        { error: "Authentication database is temporarily unavailable. Please retry." },
        { status: 503 },
      );
    }
    return Response.json(
      { error: error instanceof Error ? error.message : "Failed to start automation job." },
      { status: 500 },
    );
  }
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId")?.trim();
  if (!jobId) return Response.json({ error: "Missing jobId." }, { status: 400 });

  const session = await getSessionFromCookies();
  if (!session) return Response.json({ error: "Authentication required." }, { status: 401 });
  const ownedJob = await getAutomationJobForUser(jobId, session.userId);
  if (!ownedJob) return Response.json({ error: "Run not found." }, { status: 404 });

  return streamScrapeJobEvents(req, jobId, getLastEventId(req, url));
}

export async function PATCH(req: Request) {
  const session = await getSessionFromCookies();
  if (!session) return Response.json({ error: "Authentication required." }, { status: 401 });
  const body = await req.json().catch(() => null) as {
    jobId?: string;
    inputName?: string;
    value?: string;
  } | null;
  if (!body?.jobId || !body.inputName || !body.value?.trim()) {
    return Response.json({ error: "Missing jobId, inputName, or value." }, { status: 400 });
  }
  if (!(await getAutomationJobForUser(body.jobId, session.userId))) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
  if (!submitScrapeJobInput(body.jobId, body.inputName, body.value.trim())) {
    return Response.json({ error: "No pending input request was found." }, { status: 404 });
  }
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await getSessionFromCookies();
  if (!session) return Response.json({ error: "Authentication required." }, { status: 401 });
  const jobId = new URL(req.url).searchParams.get("jobId")?.trim();
  if (!jobId) return Response.json({ error: "Missing jobId." }, { status: 400 });
  if (!(await getAutomationJobForUser(jobId, session.userId))) {
    return Response.json({ error: "Run not found." }, { status: 404 });
  }
  cancelScrapeJob(jobId, "Automation workflow cancellation requested.");
  emitScrapeJobEvent(jobId, { type: "cancelled" });
  emitScrapeJobEvent(jobId, { type: "done" });
  await updateAutomationJob({ jobId, status: "cancelled" });
  scheduleTaskShutdownAfterWorkflow("eligibility-verification:cancelled");
  return Response.json({ ok: true });
}

async function getBlockingActiveAutomationJobForUser(userId: string) {
  const activeJob = await getActiveAutomationJobForUser(userId);
  if (!activeJob) return null;

  const runtimeJob = getScrapeJob(activeJob.jobId);
  const updatedAt = Date.parse(activeJob.updatedAt);
  const isStaleByAge = Number.isFinite(updatedAt) && Date.now() - updatedAt > LOCAL_STALE_JOB_MS;
  const runtimeTerminal =
    runtimeJob?.status === "done" ||
    runtimeJob?.status === "error" ||
    runtimeJob?.status === "cancelled";

  if (activeJob.status === "waiting_resume" || !runtimeJob || runtimeTerminal || isStaleByAge) {
    await updateAutomationJob({
      jobId: activeJob.jobId,
      status: runtimeJob?.status === "cancelled" ? "cancelled" : "failed",
    }).catch(() => {});
    return null;
  }

  return activeJob;
}

async function persistEvent(jobId: string, event: Record<string, unknown>) {
  if (event.type === "log" && typeof event.message === "string") {
    await appendAutomationJobLog({
      jobId,
      level: typeof event.level === "string" ? event.level : "info",
      message: event.message,
      eventName: typeof event.eventName === "string" ? event.eventName : undefined,
      rowIndex: typeof event.rowIndex === "number" ? event.rowIndex : undefined,
      metadata: isRecord(event.meta) ? event.meta : undefined,
    }).catch(() => {});
  } else if (event.type === "progress") {
    await updateAutomationJob({
      jobId,
      status: "running",
      currentCompleted: typeof event.completed === "number" ? event.completed : undefined,
      totalItems: typeof event.total === "number" ? event.total : undefined,
    }).catch(() => {});
  } else if (event.type === "error") {
    await updateAutomationJob({ jobId, status: "failed" }).catch(() => {});
  } else if (event.type === "cancelled") {
    await updateAutomationJob({ jobId, status: "cancelled" }).catch(() => {});
  } else if (["error_screenshot", "debug_html", "file_download", "output_snapshot"].includes(String(event.type))) {
    const s3Key = await uploadWorkflowArtifact({
      workflowId: "eligibility-verification",
      jobId,
      artifactType: String(event.type),
      filename: typeof event.filename === "string" ? event.filename : automationArtifactFilename(event),
      path: typeof event.path === "string" ? event.path : undefined,
      base64: typeof event.base64 === "string" ? event.base64 : typeof event.image === "string" ? event.image : undefined,
      text: typeof event.html === "string" ? event.html : undefined,
      mimeType: typeof event.mimeType === "string" ? event.mimeType : undefined,
    }).catch((error) => {
      console.error("Upload eligibility output artifact to S3 failed", error);
      return "";
    });
    await appendAutomationJobArtifact({
      jobId,
      artifactType: String(event.type),
      rowIndex: typeof event.index === "number" ? event.index : undefined,
      filename: typeof event.filename === "string" ? event.filename : undefined,
      mimeType: typeof event.mimeType === "string" ? event.mimeType : undefined,
      pathOrKey: s3Key || (typeof event.path === "string" ? event.path : undefined),
    }).catch(() => {});
  }
}

async function uploadEligibilityInputs(
  jobId: string,
  inputFile: FormDataEntryValue | null,
  credentialFile: FormDataEntryValue | null,
): Promise<void> {
  await Promise.all([
    inputFile instanceof File && inputFile.size > 0
      ? uploadWorkflowFile({
          workflowId: "eligibility-verification",
          jobId,
          area: "input",
          file: inputFile,
          fallbackName: "input.xlsx",
        })
      : Promise.resolve(""),
    credentialFile instanceof File && credentialFile.size > 0
      ? uploadWorkflowFile({
          workflowId: "eligibility-verification",
          jobId,
          area: "input",
          file: credentialFile,
          fallbackName: "credentials.xlsx",
        })
      : Promise.resolve(""),
  ]);
}

function automationArtifactFilename(event: Record<string, unknown>): string {
  const type = String(event.type ?? "artifact");
  const row = typeof event.index === "number" ? `row_${event.index + 1}_` : "";
  if (type === "debug_html") return `${row}debug_${Date.now()}.html`;
  if (type === "error_screenshot") return `${row}screenshot_${Date.now()}.jpg`;
  return `${row}artifact_${Date.now()}.bin`;
}

function getRequiredString(formData: FormData, key: string): string {
  const value = getOptionalString(formData, key);
  if (!value) throw new Error(`${key} is required.`);
  return value;
}

function getOptionalString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getNumber(formData: FormData, key: string): number {
  const value = Number(getOptionalString(formData, key));
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function getFirstFile(formData: FormData, keys: string[]): File | null {
  for (const key of keys) {
    const value = formData.get(key);
    if (value instanceof File) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

