import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { patchPlaywrightBrowserEvalHelpers } from "@/backend/src/core/playwright-browser-eval-helpers";
import { cancelScrapeJob, createScrapeJob, emitScrapeJobEvent, getScrapeJob, submitScrapeJobInput } from "@/backend/src/jobs/job-store";
import {
  uploadWorkflowArtifact,
} from "@/backend/src/core/workflow-s3-storage";
import { getAutomationRunner } from "@/backend/src/workflows/registry";
import { getClaimStatusScraper } from "@/backend/src/workflows/claim-status/registry";
import type { ScraperContext } from "@/backend/src/workflows/claim-status/types";
import type { AutomationContext, AutomationWorkflowId } from "@/backend/src/workflows/types";
import {
  applyClaimRowUpdateToWorksheet,
  postProcessWorksheet,
  type ClaimRowUpdateEvent,
} from "@/backend/src/workflows/claim-status/portals/iehp/workbook-output";
import { runDbWithRetry } from "@/db";
import { workflowJobs } from "@/db/schema/workflow-runtime";
import {
  appendWorkflowEvent,
  appendWorkflowArtifact,
  consumePendingWorkflowCommands,
  updateWorkflowJob,
  type AwsWorkflowJobStatus,
} from "@/backend/src/aws/runtime/workflow-db";
import { publishWorkflowEvent } from "@/backend/src/aws/runtime/websocket-publisher";
import {
  appendScrapeJobArtifact,
  createPersistentScrapeJob,
  updateScrapeJobSnapshot,
  type PersistentScrapeJobStatus,
} from "@/lib/scrape-jobs/db";

patchPlaywrightBrowserEvalHelpers();

type FileInputSpec = {
  formField: string;
  localPathEnv: string;
  s3KeyEnv: string;
  fallbackName: string;
};

type IehpOutputWorkbook = {
  workbook: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
  claimFileName: string;
  changed: boolean;
};

const fileInputs: FileInputSpec[] = [
  {
    formField: "claimExcel",
    localPathEnv: "CLAIM_EXCEL_PATH",
    s3KeyEnv: "CLAIM_EXCEL_S3_KEY",
    fallbackName: "claim.xlsx",
  },
  {
    formField: "loginExcel",
    localPathEnv: "LOGIN_EXCEL_PATH",
    s3KeyEnv: "LOGIN_EXCEL_S3_KEY",
    fallbackName: "login.xlsx",
  },
  {
    formField: "inputExcel",
    localPathEnv: "INPUT_EXCEL_PATH",
    s3KeyEnv: "INPUT_EXCEL_S3_KEY",
    fallbackName: "input.xlsx",
  },
  {
    formField: "credentialExcel",
    localPathEnv: "CREDENTIAL_EXCEL_PATH",
    s3KeyEnv: "CREDENTIAL_EXCEL_S3_KEY",
    fallbackName: "credentials.xlsx",
  },
  {
    formField: "inputFile",
    localPathEnv: "INPUT_FILE_PATH",
    s3KeyEnv: "INPUT_FILE_S3_KEY",
    fallbackName: "input.xlsx",
  },
  {
    formField: "credentialFile",
    localPathEnv: "CREDENTIAL_FILE_PATH",
    s3KeyEnv: "CREDENTIAL_FILE_S3_KEY",
    fallbackName: "credentials.xlsx",
  },
  {
    formField: "referenceExcel",
    localPathEnv: "REFERENCE_EXCEL_PATH",
    s3KeyEnv: "REFERENCE_EXCEL_S3_KEY",
    fallbackName: "reference.xlsx",
  },
];

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) s3Client = new S3Client({});
  return s3Client;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} must be set for the worker.`);
  return value;
}

function optionalEnv(name: string): string {
  return process.env[name]?.trim() || "";
}

function writeCloudWatchLog(event: {
  jobId: string;
  workflowId: string;
  portalId: string;
  level?: string;
  message: string;
  eventName?: string;
  rowIndex?: number | string;
  meta?: unknown;
}): void {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    source: "workflow-worker",
    jobId: event.jobId,
    workflowId: event.workflowId,
    portalId: event.portalId,
    level: event.level ?? "info",
    eventName: event.eventName,
    rowIndex: event.rowIndex,
    message: event.message,
    meta: event.meta,
  }));
}

function hasDatabase(): boolean {
  return Boolean(optionalEnv("DATABASE_URL"));
}

function getInputBucket(): string {
  return optionalEnv("WORKFLOW_INPUTS_BUCKET") || optionalEnv("WORKFLOW_INPUT_BUCKET");
}

async function downloadS3Object(bucket: string, key: string): Promise<Uint8Array> {
  const result = await getS3Client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!result.Body) throw new Error(`S3 object body was empty for ${bucket}/${key}.`);
  return result.Body.transformToByteArray();
}

async function readInputBytes(spec: FileInputSpec): Promise<{ bytes: Uint8Array; filename: string } | null> {
  const localPath = optionalEnv(spec.localPathEnv);
  if (localPath) {
    return {
      bytes: await fs.readFile(localPath),
      filename: path.basename(localPath) || spec.fallbackName,
    };
  }

  const s3Key = optionalEnv(spec.s3KeyEnv);
  if (s3Key) {
    return {
      bytes: await downloadS3Object(requiredInputBucket(), s3Key),
      filename: path.basename(s3Key) || spec.fallbackName,
    };
  }

  return null;
}

function requiredInputBucket(): string {
  const bucket = getInputBucket();
  if (!bucket) {
    throw new Error("WORKFLOW_INPUTS_BUCKET must be set when using S3 input keys.");
  }
  return bucket;
}

function appendJsonFields(formData: FormData): void {
  const raw = optionalEnv("FORM_FIELDS_JSON");
  if (!raw) return;

  const parsed = JSON.parse(raw) as Record<string, unknown>;
  for (const [key, value] of Object.entries(parsed)) {
    if (value === null || value === undefined) continue;
    formData.set(key, String(value));
  }
}

async function appendClaimRows(formData: FormData): Promise<void> {
  const claimRowsJson = optionalEnv("CLAIM_ROWS_JSON");
  if (claimRowsJson) {
    formData.set("claimRows", claimRowsJson);
    return;
  }

  const claimRowsPath = optionalEnv("CLAIM_ROWS_PATH");
  if (claimRowsPath) {
    formData.set("claimRows", await fs.readFile(claimRowsPath, "utf8"));
    return;
  }

  const claimRowsKey = optionalEnv("CLAIM_ROWS_S3_KEY");
  if (claimRowsKey) {
    const bytes = await downloadS3Object(requiredInputBucket(), claimRowsKey);
    formData.set("claimRows", Buffer.from(bytes).toString("utf8"));
  }
}

async function buildFormData(portalId: string): Promise<FormData> {
  const formData = new FormData();
  formData.set("portalId", portalId);
  formData.set("workflowId", optionalEnv("WORKFLOW_ID") || "claim-status");

  appendIfSet(formData, "payerId", optionalEnv("PAYER_ID"));
  appendIfSet(formData, "startIndex", optionalEnv("START_INDEX"));
  appendIfSet(formData, "claimFileName", optionalEnv("CLAIM_FILE_NAME"));
  appendIfSet(formData, "loginFileName", optionalEnv("LOGIN_FILE_NAME"));
  appendIfSet(formData, "projectId", optionalEnv("PROJECT_ID"));
  appendIfSet(formData, "checkpointId", optionalEnv("CHECKPOINT_ID"));
  appendIfSet(formData, "resetCheckpoint", optionalEnv("RESET_CHECKPOINT"));
  appendJsonFields(formData);

  for (const spec of fileInputs) {
    const input = await readInputBytes(spec);
    if (!input) continue;
    const arrayBuffer = new ArrayBuffer(input.bytes.byteLength);
    new Uint8Array(arrayBuffer).set(input.bytes);
    const file = new File([arrayBuffer], input.filename);
    formData.set(spec.formField, file);
    if (spec.formField === "claimExcel" && !formData.has("claimFileName")) {
      formData.set("claimFileName", input.filename);
    }
    if (spec.formField === "loginExcel" && !formData.has("loginFileName")) {
      formData.set("loginFileName", input.filename);
    }
    if ((spec.formField === "inputFile" || spec.formField === "referenceExcel") && !formData.has("claimFileName")) {
      formData.set("claimFileName", input.filename);
    }
    if (spec.formField === "credentialFile" && !formData.has("loginFileName")) {
      formData.set("loginFileName", input.filename);
    }
  }

  await appendClaimRows(formData);
  return formData;
}

async function buildIehpOutputWorkbook(formData: FormData): Promise<IehpOutputWorkbook | null> {
  const claimFile = formData.get("claimExcel");
  if (!(claimFile instanceof File) || claimFile.size === 0) return null;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await claimFile.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("IEHP claim workbook does not contain a worksheet.");

  return {
    workbook,
    worksheet,
    claimFileName: stringField(formData, "claimFileName") || claimFile.name || "claim.xlsx",
    changed: false,
  };
}

function appendIfSet(formData: FormData, key: string, value: string): void {
  if (value) formData.set(key, value);
}

async function persistEvent(jobId: string, data: Record<string, unknown>): Promise<void> {
  if (!hasDatabase()) return;

  const eventId = isPersistentWorkflowEvent(data)
    ? await appendWorkflowEvent(jobId, persistentWorkflowEventType(data), persistentWorkflowEventPayload(data)).catch(() => null)
    : null;
  await publishWorkflowEvent(jobId, data, eventId).catch(() => {});

  if (data.type === "progress") {
    await updateWorkflowJob({
      jobId,
      status: "running",
      currentCompleted: typeof data.completed === "number" ? data.completed : undefined,
      totalRows: typeof data.total === "number" ? data.total : undefined,
    }).catch(() => {});
    await updateScrapeJobSnapshot({
      jobId,
      status: "running",
      currentCompleted: typeof data.completed === "number" ? data.completed : undefined,
      totalRows: typeof data.total === "number" ? data.total : undefined,
    }).catch(() => {});
    return;
  }

  if (data.type === "row_progress") {
    const completed = typeof data.completed === "number"
      ? data.completed
      : typeof data.current === "number"
        ? Math.max(0, data.current - 1)
        : undefined;
    const total = typeof data.total === "number" ? data.total : undefined;
    await updateWorkflowJob({
      jobId,
      status: "running",
      currentCompleted: completed,
      totalRows: total,
    }).catch(() => {});
    await updateScrapeJobSnapshot({
      jobId,
      status: "running",
      currentCompleted: completed,
      totalRows: total,
    }).catch(() => {});
    return;
  }

  if (data.type === "input_request" || data.type === "otp_request") {
    await updateWorkflowJob({ jobId, status: "waiting_otp" }).catch(() => {});
    return;
  }

  if (isArtifactEvent(data)) {
    const s3Key = await uploadWorkflowArtifact({
      workflowId: "claim-status",
      jobId,
      artifactType: String(data.type),
      filename: typeof data.filename === "string" ? data.filename : artifactFilename(data),
      path: typeof data.path === "string" ? data.path : undefined,
      base64: typeof data.base64 === "string" ? data.base64 : typeof data.image === "string" ? data.image : undefined,
      text: typeof data.html === "string" ? data.html : undefined,
      mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
    }).catch((error) => {
      console.error("Worker artifact upload failed", error);
      return "";
    });

    await appendScrapeJobArtifact({
      jobId,
      rowIndex: typeof data.index === "number" ? data.index : null,
      artifactType: String(data.type),
      filename: typeof data.filename === "string" ? data.filename : undefined,
      mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
      pathOrKey: s3Key || (typeof data.path === "string" ? data.path : undefined),
    }).catch(() => {});
    if (s3Key && process.env.WORKFLOW_OUTPUTS_BUCKET) {
      await appendWorkflowArtifact({
        jobId,
        artifactType: String(data.type),
        filename: typeof data.filename === "string" ? data.filename : artifactFilename(data),
        bucket: process.env.WORKFLOW_OUTPUTS_BUCKET,
        s3Key,
        mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
      }).catch(() => {});
    }
  }
}

function isAutomationWorkflowId(value: string): value is AutomationWorkflowId {
  return value === "eligibility-verification" || value === "payment-eob-download" || value === "payment-posting";
}

async function persistAutomationEvent(jobId: string, workflowId: AutomationWorkflowId, data: Record<string, unknown>): Promise<void> {
  if (!hasDatabase()) return;

  const eventId = isPersistentWorkflowEvent(data)
    ? await appendWorkflowEvent(jobId, persistentWorkflowEventType(data), persistentWorkflowEventPayload(data)).catch(() => null)
    : null;
  await publishWorkflowEvent(jobId, data, eventId).catch(() => {});

  if (data.type === "progress") {
    await updateWorkflowJob({
      jobId,
      status: "running",
      currentCompleted: typeof data.completed === "number" ? data.completed : undefined,
      totalRows: typeof data.total === "number" ? data.total : undefined,
    }).catch(() => {});
  }

  if (data.type === "row_progress") {
    const completed = typeof data.completed === "number"
      ? data.completed
      : typeof data.current === "number"
        ? Math.max(0, data.current - 1)
        : undefined;
    await updateWorkflowJob({
      jobId,
      status: "running",
      currentCompleted: completed,
      totalRows: typeof data.total === "number" ? data.total : undefined,
    }).catch(() => {});
  }

  if (data.type === "input_request" || data.type === "otp_request") {
    await updateWorkflowJob({ jobId, status: "waiting_otp" }).catch(() => {});
  }

  if (isArtifactEvent(data)) {
    const s3Key = await uploadWorkflowArtifact({
      workflowId,
      jobId,
      artifactType: String(data.type),
      filename: typeof data.filename === "string" ? data.filename : artifactFilename(data),
      path: typeof data.path === "string" ? data.path : undefined,
      base64: typeof data.base64 === "string" ? data.base64 : typeof data.image === "string" ? data.image : undefined,
      text: typeof data.html === "string" ? data.html : undefined,
      mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
    }).catch((error) => {
      console.error("Worker automation artifact upload failed", error);
      return "";
    });

    if (s3Key && process.env.WORKFLOW_OUTPUTS_BUCKET) {
      await appendWorkflowArtifact({
        jobId,
        artifactType: String(data.type),
        filename: typeof data.filename === "string" ? data.filename : artifactFilename(data),
        bucket: process.env.WORKFLOW_OUTPUTS_BUCKET,
        s3Key,
        mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
      }).catch(() => {});
    }
  }
}

async function uploadIehpOutputWorkbook(jobId: string, outputWorkbook: IehpOutputWorkbook | null): Promise<boolean> {
  if (!outputWorkbook) return false;

  postProcessWorksheet(outputWorkbook.worksheet);
  const buffer = Buffer.from(await outputWorkbook.workbook.xlsx.writeBuffer());
  const outputBucket = process.env.WORKFLOW_OUTPUTS_BUCKET;
  if (!outputBucket) throw new Error("WORKFLOW_OUTPUTS_BUCKET must be set to upload IEHP output.");

  const parsedName = path.parse(outputWorkbook.claimFileName);
  const filename = `${parsedName.name || "iehp_claims"}_output.xlsx`;
  const key = [
    "claim-status",
    new Date().toISOString().slice(0, 10),
    jobId,
    "output",
    filename,
  ].join("/");

  await getS3Client().send(new PutObjectCommand({
    Bucket: outputBucket,
    Key: key,
    Body: buffer,
    ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));

  await appendWorkflowArtifact({
    jobId,
    artifactType: "output_snapshot",
    filename,
    bucket: outputBucket,
    s3Key: key,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  await appendScrapeJobArtifact({
    jobId,
    rowIndex: null,
    artifactType: "output_snapshot",
    filename,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    pathOrKey: key,
  }).catch(() => {});
  await appendWorkflowEvent(jobId, "output_ready", { type: "output_ready", filename }).catch(() => {});
  await publishWorkflowEvent(jobId, { type: "output_ready", filename }).catch(() => {});
  return true;
}

function isClaimRowUpdateEvent(event: Record<string, unknown>): event is ClaimRowUpdateEvent {
  return event.type === "row_update" &&
    typeof event.index === "number" &&
    typeof event.update === "object" &&
    event.update !== null;
}

function isArtifactEvent(data: Record<string, unknown>): boolean {
  return (
    data.type === "error_screenshot" ||
    data.type === "debug_html" ||
    data.type === "pdf_download" ||
    data.type === "file_download" ||
    data.type === "output_snapshot"
  );
}

function isPersistentWorkflowEvent(data: Record<string, unknown>): boolean {
  const type = String(data.type ?? "");
  return (
    type === "job_started" ||
    type === "task_starting" ||
    type === "progress" ||
    type === "row_progress" ||
    type === "input_request" ||
    type === "otp_request" ||
    type === "input_submitted" ||
    type === "cancellation_acknowledged" ||
    type === "cancelled" ||
    type === "completed" ||
    type === "failed" ||
    type === "output_ready"
  );
}

function persistentWorkflowEventType(data: Record<string, unknown>): string {
  const type = String(data.type ?? "event");
  if (type === "otp_request") return "input_request";
  return type;
}

function persistentWorkflowEventPayload(data: Record<string, unknown>): Record<string, unknown> {
  const type = String(data.type ?? "event");
  if (type === "progress") {
    const payload: Record<string, unknown> = { type };
    if (typeof data.completed === "number") payload.completed = data.completed;
    if (typeof data.total === "number") payload.total = data.total;
    if (typeof data.currentRow === "number") payload.currentRow = data.currentRow;
    return payload;
  }
  if (type === "row_progress") {
    const payload: Record<string, unknown> = { type };
    if (typeof data.completed === "number") payload.completed = data.completed;
    if (typeof data.current === "number") payload.current = data.current;
    if (typeof data.total === "number") payload.total = data.total;
    return payload;
  }
  if (type === "input_request" || type === "otp_request") {
    const { value: _value, otp: _otp, secret: _secret, ...payload } = data;
    return payload;
  }
  return data;
}

function artifactFilename(data: Record<string, unknown>): string {
  const type = String(data.type ?? "artifact");
  const row = typeof data.index === "number" ? `row_${data.index + 1}_` : "";
  if (type === "debug_html") return `${row}debug_${Date.now()}.html`;
  if (type === "error_screenshot") return `${row}screenshot_${Date.now()}.jpg`;
  if (type === "pdf_download") return `${row}download_${Date.now()}.pdf`;
  if (type === "output_snapshot") return `${row}output_${Date.now()}.xlsx`;
  return `${row}artifact_${Date.now()}.bin`;
}

async function createOrUpdateJob(jobId: string, userId: string, portalId: string, formData: FormData): Promise<void> {
  if (!hasDatabase() || !userId) return;

  await createPersistentScrapeJob({
    jobId,
    userId,
    portalId,
    claimFileName: stringField(formData, "claimFileName"),
    loginFileName: stringField(formData, "loginFileName"),
    currentCompleted: numberField(formData, "startIndex"),
  });
}

function stringField(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function numberField(formData: FormData, key: string): number {
  const value = Number(stringField(formData, key));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

type CancellationPoll = {
  isCancelled: () => boolean;
  waitForCancellation: Promise<void>;
  stop: () => void;
};

function cancellationGraceMs(): number {
  const parsed = Number(process.env.WORKFLOW_CANCEL_GRACE_MS || "120000");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120000;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRunWithCancellation(
  runPromise: Promise<"completed">,
  cancellation: CancellationPoll,
  log: (message: string) => Promise<void>,
): Promise<"completed" | "cancelled"> {
  const firstResult = await Promise.race([
    runPromise,
    cancellation.waitForCancellation.then(() => "cancel_requested" as const),
  ]);

  if (firstResult !== "cancel_requested") return firstResult;

  const graceMs = cancellationGraceMs();
  await log(`Cancellation requested. Waiting up to ${Math.round(graceMs / 1000)}s for portal cleanup and partial output.`);
  const graceResult = await Promise.race([
    runPromise.then((result) => ({ type: "run_completed" as const, result })),
    delay(graceMs).then(() => ({ type: "cancel_timeout" as const })),
  ]);

  if (graceResult.type === "run_completed") return graceResult.result;

  runPromise.catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    void log(`Portal cleanup continued after cancellation timeout and failed: ${message}`);
  });
  return "cancelled";
}

function startCancellationPoll(jobId: string): CancellationPoll {
  if (!hasDatabase()) return { isCancelled: () => false, waitForCancellation: new Promise(() => {}), stop: () => {} };

  let cancelled = false;
  let resolveCancellation: () => void = () => {};
  const waitForCancellation = new Promise<void>((resolve) => {
    resolveCancellation = resolve;
  });
  const markCancelled = () => {
    if (cancelled) return;
    cancelled = true;
    cancelScrapeJob(jobId, "Cancellation requested.", { emitDone: false });
    resolveCancellation();
  };
  const checkCancellation = async () => {
    await Promise.all([
      runDbWithRetry((db) =>
        db.select({ status: workflowJobs.status }).from(workflowJobs).where(eq(workflowJobs.jobId, jobId)).limit(1),
      ).then((rows) => {
        const status = rows[0]?.status;
        if (status === "cancelled" || status === "cancelling") {
          markCancelled();
        }
      }),
      consumePendingWorkflowCommands(jobId).then((commands) => {
        for (const command of commands) {
          if (command.commandType === "cancel") {
            markCancelled();
            continue;
          }
          const payload = command.payload as { value?: unknown };
          if (typeof payload.value === "string" && payload.value.trim()) {
            submitScrapeJobInput(jobId, command.commandType, payload.value.trim());
            submitScrapeJobInput(jobId, "otp", payload.value.trim());
            submitScrapeJobInput(jobId, "regalOtp", payload.value.trim());
          }
        }
      }),
    ]);
  };
  void checkCancellation().catch(() => {});
  const timer = setInterval(() => {
    void checkCancellation().catch(() => {});
  }, 1500);

  return {
    isCancelled: () => cancelled,
    waitForCancellation,
    stop: () => clearInterval(timer),
  };
}

async function runAutomationWorkflow(params: {
  jobId: string;
  workflowId: AutomationWorkflowId;
  portalId: string;
  formData: FormData;
}): Promise<void> {
  const runner = getAutomationRunner(params.workflowId, params.portalId, stringField(params.formData, "payerId"));
  const input = runner.validateInput(params.formData);
  const job = createScrapeJob(params.jobId, params.workflowId);
  const cancellation = startCancellationPoll(params.jobId);
  let workflowErrorMessage = "";

  await updateWorkflowJob({ jobId: params.jobId, status: "running" }).catch(() => {});
  const startedEvent = { type: "log", message: `Worker started for ${params.workflowId}/${params.portalId}.` };
  emitScrapeJobEvent(job.id, startedEvent);
  await persistAutomationEvent(params.jobId, params.workflowId, startedEvent);

  const context: AutomationContext = {
    jobId: params.jobId,
    workflowId: params.workflowId,
    portalId: params.portalId,
    payerId: stringField(params.formData, "payerId") || undefined,
    isCancelled: cancellation.isCancelled,
    emit: async (event) => {
      emitScrapeJobEvent(job.id, event);
      if (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "error" &&
        "message" in event &&
        typeof event.message === "string"
      ) {
        workflowErrorMessage = event.message;
      }
      await persistAutomationEvent(params.jobId, params.workflowId, event);
    },
    log: async (event) => {
      const payload = {
        type: "log",
        message: event.message,
        level: event.level,
        eventName: event.eventName,
        rowIndex: event.rowIndex,
        meta: event.meta,
      };
      writeCloudWatchLog({
        jobId: params.jobId,
        workflowId: params.workflowId,
        portalId: params.portalId,
        level: event.level,
        message: event.message,
        eventName: event.eventName,
        rowIndex: event.rowIndex,
        meta: event.meta,
      });
      if (event.level === "error" && !workflowErrorMessage) {
        workflowErrorMessage = event.message;
      }
      emitScrapeJobEvent(job.id, payload);
      await persistAutomationEvent(params.jobId, params.workflowId, payload);
    },
  };

  try {
    const runResult = await waitForRunWithCancellation(
      runner.run(input, context).then(() => "completed" as const),
      cancellation,
      (message) => context.log({ level: "warn", message }),
    );
    if (runResult === "cancelled") {
      workflowErrorMessage = "";
    }
    if (workflowErrorMessage) throw new Error(workflowErrorMessage);
    const currentJob = getScrapeJob(job.id);
    const completed = currentJob?.currentCompleted ?? 0;
    const total = currentJob?.totalRows ?? 0;
    const status: AwsWorkflowJobStatus = runResult === "cancelled" || cancellation.isCancelled() ? "cancelled" : "completed";
    await updateWorkflowJob({ jobId: params.jobId, status, currentCompleted: completed, totalRows: total }).catch(() => {});
    const finalEvent = { type: status === "cancelled" ? "cancelled" : "completed" };
    const finalEventId = await appendWorkflowEvent(params.jobId, finalEvent.type, finalEvent).catch(() => null);
    await publishWorkflowEvent(params.jobId, finalEvent, finalEventId).catch(() => {});
    const doneEvent = { type: "done" };
    emitScrapeJobEvent(job.id, doneEvent);
    await publishWorkflowEvent(params.jobId, doneEvent).catch(() => {});
    console.log(`Worker finished for ${params.workflowId}/${params.portalId} job ${params.jobId} with status ${status}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected worker error.";
    await updateWorkflowJob({ jobId: params.jobId, status: "failed", errorMessage: message }).catch(() => {});
    const failedEvent = { type: "failed", message };
    const failedEventId = await appendWorkflowEvent(params.jobId, "failed", failedEvent).catch(() => null);
    await publishWorkflowEvent(params.jobId, failedEvent, failedEventId).catch(() => {});
    await publishWorkflowEvent(params.jobId, { type: "done" }).catch(() => {});
    console.error(error);
  } finally {
    cancellation.stop();
  }
}

export async function main(): Promise<void> {
  const jobId = requiredEnv("JOB_ID");
  const workflowId = optionalEnv("WORKFLOW_ID") || "claim-status";
  const portalId = requiredEnv("PORTAL_ID");
  const userId = optionalEnv("USER_ID");
  const formData = await buildFormData(portalId);
  if (isAutomationWorkflowId(workflowId)) {
    await runAutomationWorkflow({ jobId, workflowId, portalId, formData });
    return;
  }

  const scraper = await getClaimStatusScraper(portalId);
  const input = scraper.validateInput(formData);
  const job = createScrapeJob(jobId);
  const cancellation = startCancellationPoll(jobId);
  const iehpOutputWorkbook = portalId === "iehp" ? await buildIehpOutputWorkbook(formData) : null;
  let scraperErrorMessage = "";

  await createOrUpdateJob(jobId, userId, portalId, formData);
  await updateWorkflowJob({ jobId, status: "running" }).catch(() => {});
  const workerStartedEvent = { type: "log", message: `Worker started for ${portalId}.` };
  emitScrapeJobEvent(job.id, workerStartedEvent);
  await persistEvent(job.id, workerStartedEvent);

  const context: ScraperContext = {
    jobId,
    portalId,
    isCancelled: cancellation.isCancelled,
    emit: async (event) => {
      emitScrapeJobEvent(job.id, event);
      if (
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "error" &&
        "message" in event &&
        typeof event.message === "string"
      ) {
        scraperErrorMessage = event.message;
      }
      if (iehpOutputWorkbook && isClaimRowUpdateEvent(event as Record<string, unknown>)) {
        applyClaimRowUpdateToWorksheet(iehpOutputWorkbook.worksheet, event as ClaimRowUpdateEvent);
        iehpOutputWorkbook.changed = true;
      }
      await persistEvent(job.id, event);
    },
    log: async (event) => {
      const payload = {
        type: "log",
        message: event.message,
        level: event.level,
        eventName: event.eventName,
        rowIndex: event.rowIndex,
        meta: event.meta,
      };
      writeCloudWatchLog({
        jobId,
        workflowId,
        portalId,
        level: event.level,
        message: event.message,
        eventName: event.eventName,
        rowIndex: event.rowIndex,
        meta: event.meta,
      });
      if (event.level === "error" && !scraperErrorMessage) {
        scraperErrorMessage = event.message;
      }
      emitScrapeJobEvent(job.id, payload);
      await persistEvent(job.id, payload);
    },
  };

  try {
    const runResult = await waitForRunWithCancellation(
      scraper.run(input, context).then(() => "completed" as const),
      cancellation,
      (message) => context.log({ level: "warn", message }),
    );
    if (runResult === "cancelled") {
      scraperErrorMessage = "";
    }
    if (scraperErrorMessage) {
      throw new Error(scraperErrorMessage);
    }
    const currentJob = getScrapeJob(job.id);
    const completed = currentJob?.currentCompleted ?? 0;
    const total = currentJob?.totalRows ?? 0;
    const uploadedIehpOutput = portalId === "iehp"
      ? await uploadIehpOutputWorkbook(jobId, iehpOutputWorkbook)
      : false;
    const status: PersistentScrapeJobStatus = runResult === "cancelled" || cancellation.isCancelled()
      ? "cancelled"
      : total > 0 && completed < total
        ? "waiting_resume"
        : "completed";
    if (status === "completed" && portalId === "iehp" && !uploadedIehpOutput) {
      throw new Error("IEHP worker completed without producing an output workbook artifact.");
    }
    const awsStatus: AwsWorkflowJobStatus = status === "waiting_resume" ? "failed" : status;
    await updateWorkflowJob({ jobId, status: awsStatus, currentCompleted: completed, totalRows: total }).catch(() => {});
    await updateScrapeJobSnapshot({ jobId, status, currentCompleted: completed, totalRows: total }).catch(() => {});
    const finalEvent = { type: status === "cancelled" ? "cancelled" : "completed" };
    const finalEventId = await appendWorkflowEvent(jobId, finalEvent.type, finalEvent).catch(() => null);
    await publishWorkflowEvent(jobId, finalEvent, finalEventId).catch(() => {});
    const doneEvent = { type: "done" };
    emitScrapeJobEvent(job.id, doneEvent);
    await publishWorkflowEvent(jobId, doneEvent).catch(() => {});
    console.log(`Worker finished for ${portalId} job ${jobId} with status ${status}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected worker error.";
    if (portalId === "iehp") {
      await uploadIehpOutputWorkbook(jobId, iehpOutputWorkbook).catch((uploadError) => {
        console.error("IEHP partial workbook upload failed", uploadError);
      });
    }
    await updateWorkflowJob({
      jobId,
      status: cancellation.isCancelled() ? "cancelled" : "failed",
      currentCompleted: getScrapeJob(job.id)?.currentCompleted ?? 0,
      totalRows: getScrapeJob(job.id)?.totalRows ?? 0,
      errorMessage: message,
    }).catch(() => {});
    const failedEvent = { type: "failed", message };
    const failedEventId = await appendWorkflowEvent(jobId, "failed", failedEvent).catch(() => null);
    await publishWorkflowEvent(jobId, failedEvent, failedEventId).catch(() => {});
    await updateScrapeJobSnapshot({
      jobId,
      status: cancellation.isCancelled() ? "cancelled" : "failed",
      currentCompleted: getScrapeJob(job.id)?.currentCompleted ?? 0,
      totalRows: getScrapeJob(job.id)?.totalRows ?? 0,
    }).catch(() => {});
    console.error(error);
    process.exitCode = 1;
  } finally {
    cancellation.stop();
  }
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main()
    .then(() => {
      setTimeout(() => process.exit(process.exitCode ?? 0), Number(optionalEnv("EXIT_AFTER_WORKFLOW_DELAY_MS")) || 1000);
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 1000);
    });
}
