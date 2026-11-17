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
import { isAutomationWorkflowId, type AutomationContext, type AutomationWorkflowId } from "@/backend/src/workflows/types";
import { createEligibilityPartialOutput } from "@/backend/src/workflows/eligibility-verification/partial-output";
import {
  applyClaimRowUpdateToWorksheet,
  postProcessWorksheet,
  type ClaimRowUpdateEvent,
} from "@/backend/src/workflows/claim-status/portals/iehp/workbook-output";
import {
  applyUhcRowUpdateToWorksheet,
  postProcessUhcWorksheet,
} from "@/backend/src/workflows/claim-status/portals/uhc/workbook-output";
import { runDbWithRetry } from "@/db";
import { workflowJobs } from "@/db/schema/workflow-runtime";
import {
  appendWorkflowEvent,
  appendWorkflowArtifact,
  getWorkflowJobById,
  getArtifactManifest,
  consumePendingWorkflowCommands,
  updateWorkflowJob,
  resumeWorkflowJobAfterInput,
  type AwsWorkflowJobStatus,
} from "@/backend/src/aws/runtime/workflow-db";
import { publishWorkflowEvent } from "@/backend/src/aws/runtime/websocket-publisher";
import { isInputRequest, isPersistentWorkflowEvent, persistentWorkflowEventType, persistentWorkflowEventPayload } from "@/backend/src/aws/runtime/job-event-policy";
import { deliverWorkerInput } from "./input-delivery";
import { createJobArtifactBundle } from "@/backend/src/aws/http/iehp-bundle";
import { loadServiceExpectedRefs, serviceOutputWorkbookLocation, type ServiceWorkbookArtifact } from "@/backend/src/aws/service/iehp-snapshot";
import { loadIntegratedServiceSnapshot } from "@/backend/src/aws/service/workflow-registry";
import { createClaimResultPublisher } from "./claim-result-publisher";
import { publishWorkerResultSnapshot, publishServiceResultPage, readWorkerServiceResultPage } from "../service/result-publication-store";
import { normalizeEligibilityServiceWorkbook } from "../service/eligibility-results";
import { isEligibilityServicePortal, eligibilityServiceOutputFilenames, eligibilityServiceProject } from "../service/eligibility-portals";
import { validateWorkerManifest, workerManifestSummary, workerResultManifestKey } from "../service/worker-result-contract";
import { clearPreviousWorkerOutput } from "../../workflows/claim-status/output-columns";
import {
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

type ClaimOutputWorkbook = {
  workbook: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
  claimFileName: string;
  changed: boolean;
  outputKey?: string;
  publish?: (bytes: Uint8Array, artifact: ServiceWorkbookArtifact) => Promise<void>;
};

type UploadClaimOutputWorkbookOptions = {
  portalId: "iehp" | "uhc";
  finalize?: boolean;
  announce?: boolean;
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
  {
    formField: "selectionRulesFile",
    localPathEnv: "SELECTION_RULES_FILE_PATH",
    s3KeyEnv: "SELECTION_RULES_FILE_S3_KEY",
    fallbackName: "selection-rules.xlsx",
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
  return Boolean(optionalEnv("DATABASE_URL") || optionalEnv("DATABASE_SECRET_ARN"));
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

async function buildIehpOutputWorkbook(formData: FormData): Promise<ClaimOutputWorkbook | null> {
  const claimFile = formData.get("claimExcel");
  if (!(claimFile instanceof File) || claimFile.size === 0) return null;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await claimFile.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("IEHP claim workbook does not contain a worksheet.");
  if (formData.get("integrationMode") === "service" || numberField(formData, "startIndex") === 0) clearPreviousWorkerOutput(worksheet);

  return {
    workbook,
    worksheet,
    claimFileName: stringField(formData, "claimFileName") || claimFile.name || "claim.xlsx",
    changed: false,
  };
}


async function buildUhcOutputWorkbook(formData: FormData): Promise<ClaimOutputWorkbook> {
  const claimFile = formData.get("claimExcel");
  if (!(claimFile instanceof File) || claimFile.size === 0) {
    throw new Error("UHC claim workbook is required to save partial output.");
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await claimFile.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("UHC claim workbook does not contain a worksheet.");
  if (formData.get("integrationMode") === "service" || numberField(formData, "startIndex") === 0) clearPreviousWorkerOutput(worksheet);
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

async function persistEvent(jobId: string, data: Record<string, unknown>, options: {
  requireArtifactUpload?: boolean;
  publishWorkbook?: (bytes: Uint8Array, artifact: ServiceWorkbookArtifact) => Promise<void>;
} = {}): Promise<void> {
  if (!hasDatabase()) return;

  const eventId = isPersistentWorkflowEvent(data)
    ? await appendWorkflowEvent(jobId, persistentWorkflowEventType(data), persistentWorkflowEventPayload(data)).catch(() => null)
    : null;
  await publishWorkflowEvent(jobId, data, eventId).catch(() => {});

  // Service claim counts are owned by the result publication transaction.
  if (data.type === "progress") {
    await updateWorkflowJob({
      jobId,
      status: "running",
      currentCompleted: !options.publishWorkbook && typeof data.completed === "number" ? data.completed : undefined,
      totalRows: !options.publishWorkbook && typeof data.total === "number" ? data.total : undefined,
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
      currentCompleted: options.publishWorkbook ? undefined : completed,
      totalRows: options.publishWorkbook ? undefined : total,
    }).catch(() => {});
    await updateScrapeJobSnapshot({
      jobId,
      status: "running",
      currentCompleted: completed,
      totalRows: total,
    }).catch(() => {});
    return;
  }

  if (isInputRequest(data)) {
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
      if ((data.type === "pdf_download" && data.path) || options.requireArtifactUpload) throw error;
      return "";
    });
    if (options.requireArtifactUpload && !s3Key) throw new Error("Integrated Availity output workbook could not be saved to S3.");
    if (data.type === "pdf_download" && data.path && !s3Key) {
      throw new Error("IEHP RA PDF could not be saved to S3.");
    }

    if (s3Key && process.env.WORKFLOW_OUTPUTS_BUCKET) {
      if (options.publishWorkbook && (data.type === "output_snapshot" || data.type === "file_download")
        && typeof data.filename === "string" && data.filename.toLowerCase().endsWith(".xlsx")) {
        const bytes = typeof data.base64 === "string" ? Buffer.from(data.base64, "base64")
          : typeof data.path === "string" ? await fs.readFile(data.path) : null;
        if (!bytes) throw new Error("Worker output bytes are missing.");
        await options.publishWorkbook(bytes, { bucket: process.env.WORKFLOW_OUTPUTS_BUCKET, object_key: s3Key,
          artifact_type: "output_snapshot", filename: data.filename, size_bytes: bytes.length, etag: null });
      }
      await appendWorkflowArtifact({
        jobId,
        artifactType: String(data.type),
        filename: typeof data.filename === "string" ? data.filename : artifactFilename(data),
        bucket: process.env.WORKFLOW_OUTPUTS_BUCKET,
        s3Key,
        mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
      }).catch((error) => {
        if ((data.type === "pdf_download" && data.path) || options.requireArtifactUpload) throw error;
      });
    }
  }
}

async function persistAutomationEvent(jobId: string, workflowId: AutomationWorkflowId, data: Record<string, unknown>, requireOutput = false,
  publishResults?: { filenames: string[]; publish: (bytes: Uint8Array, artifact: ServiceWorkbookArtifact) => Promise<void> }): Promise<void> {
  if (!hasDatabase()) return;

  const eventId = isPersistentWorkflowEvent(data)
    ? await appendWorkflowEvent(jobId, persistentWorkflowEventType(data), persistentWorkflowEventPayload(data)).catch(() => null)
    : null;
  await publishWorkflowEvent(jobId, data, eventId).catch(() => {});

  if (data.type === "progress" && !publishResults) {
    await updateWorkflowJob({
      jobId,
      status: "running",
      currentCompleted: typeof data.completed === "number" ? data.completed : undefined,
      totalRows: typeof data.total === "number" ? data.total : undefined,
    }).catch(() => {});
  }

  if (data.type === "row_progress" && !publishResults) {
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

  if (isInputRequest(data)) {
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
      if (requireOutput && (data.type === "file_download" || publishResults) && typeof data.filename === "string" && data.filename.endsWith(".xlsx")) throw error;
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
      }).catch((error) => {
        if (requireOutput && (data.type === "file_download" || publishResults) && typeof data.filename === "string" && data.filename.endsWith(".xlsx")) throw error;
      });
      if (publishResults && typeof data.filename === "string" && publishResults.filenames.includes(data.filename)) {
        const bytes = typeof data.base64 === "string" ? Buffer.from(data.base64, "base64")
          : typeof data.path === "string" ? await fs.readFile(data.path) : null;
        if (!bytes) throw new Error("Eligibility output bytes are unavailable for publication.");
        await publishResults.publish(bytes, { bucket: process.env.WORKFLOW_OUTPUTS_BUCKET, object_key: s3Key,
          artifact_type: "output_snapshot", filename: data.filename, size_bytes: bytes.length, etag: null });
      }
    }
  }
}

async function buildClaimOutputBuffer(outputWorkbook: ClaimOutputWorkbook, finalize: boolean, portalId: "iehp" | "uhc"): Promise<Buffer> {
  const postProcess = portalId === "uhc" ? postProcessUhcWorksheet : postProcessWorksheet;
  if (finalize) {
    postProcess(outputWorkbook.worksheet);
    return Buffer.from(await outputWorkbook.workbook.xlsx.writeBuffer());
  }

  const clone = new ExcelJS.Workbook();
  await clone.xlsx.load(await outputWorkbook.workbook.xlsx.writeBuffer());
  const worksheet = clone.worksheets[0];
  if (worksheet) {
    postProcess(worksheet);
  }
  return Buffer.from(await clone.xlsx.writeBuffer());
}

async function uploadClaimOutputWorkbook(
  jobId: string,
  outputWorkbook: ClaimOutputWorkbook | null,
  options: UploadClaimOutputWorkbookOptions,
): Promise<boolean> {
  if (!outputWorkbook) return false;

  const buffer = await buildClaimOutputBuffer(outputWorkbook, options.finalize ?? true, options.portalId);
  const outputBucket = process.env.WORKFLOW_OUTPUTS_BUCKET;
  if (!outputBucket) throw new Error("WORKFLOW_OUTPUTS_BUCKET must be set to upload claim output.");

  const parsedName = path.parse(outputWorkbook.claimFileName);
  const filename = `${parsedName.name || `${options.portalId}_claims`}_output.xlsx`;
  const key = outputWorkbook.outputKey ?? [
    "claim-status",
    new Date().toISOString().slice(0, 10),
    jobId,
    "output",
    filename,
  ].join("/");
  outputWorkbook.outputKey = key;

  await getS3Client().send(new PutObjectCommand({
    Bucket: outputBucket,
    Key: key,
    Body: buffer,
    ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  }));

  await outputWorkbook.publish?.(buffer, { bucket: outputBucket, object_key: key, artifact_type: "output_snapshot",
    filename, size_bytes: buffer.length, etag: null });

  await appendWorkflowArtifact({
    jobId,
    artifactType: "output_snapshot",
    filename,
    bucket: outputBucket,
    s3Key: key,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  if (options.announce ?? true) {
    await appendWorkflowEvent(jobId, "output_ready", { type: "output_ready", filename }).catch(() => {});
    await publishWorkflowEvent(jobId, { type: "output_ready", filename }).catch(() => {});
  }
  return true;
}

async function cacheJobArtifacts(jobId: string): Promise<void> {
  try {
    const manifest = await getArtifactManifest(jobId);
    if (manifest) await createJobArtifactBundle({ jobId, manifest });
  } catch (error) {
    console.error("Job artifact ZIP could not be prepared", error);
  }
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
      consumePendingWorkflowCommands(jobId).then(async (commands) => {
        for (const command of commands) {
          if (command.commandType === "cancel") {
            markCancelled();
            continue;
          }
          if (deliverWorkerInput(jobId, command, submitScrapeJobInput)) {
            console.log(JSON.stringify({ timestamp: new Date().toISOString(), source: "workflow-worker", jobId,
              message: "Verification response delivered to the active worker input waiter.", inputName: command.commandType }));
            await resumeWorkflowJobAfterInput(jobId, command.commandType);
            const resumed = { type: "input_consumed", inputName: command.commandType, message: "Verification response received by worker. Processing resumed." };
            const id = await appendWorkflowEvent(jobId, "input_consumed", resumed);
            await publishWorkflowEvent(jobId, resumed, id).catch(() => {});
          } else {
            console.warn(JSON.stringify({ jobId, message: "Submitted input had no matching active waiter.", inputName: command.commandType }));
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
  const isServiceJob = params.formData.get("integrationMode") === "service";
  const integratedEligibility = isServiceJob && params.workflowId === "eligibility-verification"
    && isEligibilityServicePortal(params.portalId) && params.formData.get("projectId") === eligibilityServiceProject(params.portalId);
  const savedJob = integratedEligibility ? await getWorkflowJobById(params.jobId) : null;
  if (integratedEligibility && !savedJob?.clientSystem) throw new Error("Integrated Eligibility job is missing.");
  if (savedJob && (["cancelling", "cancelled"].includes(savedJob.status)
    || (savedJob.metadata as { serviceCancelledBeforeLaunch?: boolean }).serviceCancelledBeforeLaunch)) return;
  const expectedRefs = savedJob ? await loadServiceExpectedRefs(savedJob) : [];
  const publishEligibility = integratedEligibility ? { filenames: eligibilityServiceOutputFilenames(params.portalId),
    publish: async (bytes: Uint8Array, artifact: ServiceWorkbookArtifact) => {
      const summary = await normalizeEligibilityServiceWorkbook(bytes, expectedRefs,
        { requireStatusColumns: false, unfinishedAsPending: true, portal: params.portalId });
      await publishServiceResultPage({ jobId: params.jobId, expectedRefs, summary, cursor: 0, limit: 1,
        workerState: { artifact, finalized: summary.counts.incomplete === 0 } });
    } } : undefined;
  const job = createScrapeJob(params.jobId, params.workflowId);
  const cancellation = startCancellationPoll(params.jobId);
  let workflowErrorMessage = "";
  const eligibilityInput = !integratedEligibility && params.workflowId === "eligibility-verification" && params.portalId !== "medical"
    ? params.formData.get("inputFile") : null;
  const partialOutput = eligibilityInput instanceof File
    ? await createEligibilityPartialOutput(eligibilityInput, params.portalId).catch((error) => {
      console.error("Eligibility partial workbook initialization failed", error);
      return null;
    })
    : null;
  const partialOutputDate = new Date();
  const savePartialOutput = async () => {
    if (!partialOutput || !partialOutput.hasUnsavedRows()) return;
    const key = await uploadWorkflowArtifact({
      workflowId: params.workflowId,
      jobId: params.jobId,
      artifactType: "output_snapshot",
      filename: partialOutput.filename,
      base64: partialOutput.build().toString("base64"),
      mimeType: partialOutput.mimeType,
      now: partialOutputDate,
    });
    if (!key || !process.env.WORKFLOW_OUTPUTS_BUCKET) return;
    await appendWorkflowArtifact({
      jobId: params.jobId,
      artifactType: "output_snapshot",
      filename: partialOutput.filename,
      bucket: process.env.WORKFLOW_OUTPUTS_BUCKET,
      s3Key: key,
      mimeType: partialOutput.mimeType,
    });
    partialOutput.markSaved();
  };

  await updateWorkflowJob({ jobId: params.jobId, status: "running" }).catch(() => {});
  const startedEvent = { type: "log", message: `Worker started for ${params.workflowId}/${params.portalId}.` };
  emitScrapeJobEvent(job.id, startedEvent);
  await persistAutomationEvent(params.jobId, params.workflowId, startedEvent);

  const context: AutomationContext = {
    jobId: params.jobId,
    workflowId: params.workflowId,
    portalId: params.portalId,
    payerId: stringField(params.formData, "payerId") || undefined,
    projectId: stringField(params.formData, "projectId") || undefined,
    isCancelled: cancellation.isCancelled,
    emit: async (event) => {
      if ((event.type === "log" || event.type === "warning" || event.type === "error") && typeof event.message === "string") {
        writeCloudWatchLog({ jobId: params.jobId, workflowId: params.workflowId, portalId: params.portalId,
          message: event.message, level: event.type === "error" ? "error" : "info" });
      }
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
      await persistAutomationEvent(params.jobId, params.workflowId, event, isServiceJob, publishEligibility);
      if (partialOutput?.record(event)) {
        await savePartialOutput().catch((error) => console.error("Eligibility partial workbook upload failed", error));
      }
    },
    ...(publishEligibility ? { saveServiceResults: async (bytes: Uint8Array) => {
      await persistAutomationEvent(params.jobId, params.workflowId, {
        type: "output_snapshot", filename: eligibilityServiceOutputFilenames(params.portalId)[0],
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: Buffer.from(bytes).toString("base64"),
      }, true, publishEligibility);
    } } : {}),
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
    await savePartialOutput().catch((error) => console.error("Eligibility partial workbook upload failed", error));
    if (runResult === "cancelled") {
      workflowErrorMessage = "";
    }
    if (workflowErrorMessage && !isServiceJob) throw new Error(workflowErrorMessage);
    const currentJob = getScrapeJob(job.id);
    const completed = currentJob?.currentCompleted ?? 0;
    const total = currentJob?.totalRows ?? 0;
    let status: AwsWorkflowJobStatus = runResult === "cancelled" || cancellation.isCancelled() ? "cancelled" : "completed";
    if (integratedEligibility) {
      if (status === "cancelled") status = "cancelling";
      else {
        const stored = await readWorkerServiceResultPage(params.jobId, 0, 1);
        status = stored.summary.counts.success === stored.expectedRefs.length ? "completed"
          : stored.summary.counts.success > 0 ? "partial_success" : "failed";
      }
    } else if (isServiceJob && status !== "cancelled") {
      const saved = await getWorkflowJobById(params.jobId);
      if (!saved) throw new Error("Integrated workflow job is missing after worker completion.");
      const snapshot = await loadIntegratedServiceSnapshot(saved, { requireStatusColumns: false });
      if (!snapshot.summary || !snapshot.artifact) throw new Error("Integrated workflow stopped without an output workbook.");
      if (!snapshot.recorded) {
        await appendWorkflowArtifact({
          jobId: params.jobId, artifactType: "output_snapshot",
          filename: snapshot.artifact.filename, bucket: snapshot.artifact.bucket,
          s3Key: snapshot.artifact.object_key,
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        });
      }
      status = snapshot.summary.outcome === "SUCCESS" ? "completed"
        : snapshot.summary.outcome === "PARTIAL_SUCCESS" ? "partial_success" : "failed";
    }
    await cacheJobArtifacts(params.jobId);
    await updateWorkflowJob({ jobId: params.jobId, status,
      ...(integratedEligibility ? {} : { currentCompleted: completed, totalRows: total }) }).catch(() => {});
    const finalEvent = { type: status };
    const finalEventId = await appendWorkflowEvent(params.jobId, finalEvent.type, finalEvent).catch(() => null);
    await publishWorkflowEvent(params.jobId, finalEvent, finalEventId).catch(() => {});
    const doneEvent = { type: "done" };
    emitScrapeJobEvent(job.id, doneEvent);
    await publishWorkflowEvent(params.jobId, doneEvent).catch(() => {});
    console.log(`Worker finished for ${params.workflowId}/${params.portalId} job ${params.jobId} with status ${status}.`);
  } catch (error) {
    await savePartialOutput().catch((snapshotError) => console.error("Eligibility partial workbook upload failed", snapshotError));
    await cacheJobArtifacts(params.jobId);
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
  let uhcOutputWorkbook: ClaimOutputWorkbook | null = null;
  const isServiceJob = formData.get("integrationMode") === "service";
  // One worker producer and one wire format for every Claim Status portal.
  const serviceJobMetadata = isServiceJob ? await getWorkflowJobById(jobId) : null;
  if (isServiceJob && !serviceJobMetadata) throw new Error("Integrated job metadata is missing.");
  if (serviceJobMetadata && (serviceJobMetadata.status === "cancelled" || serviceJobMetadata.status === "cancelling"
    || (serviceJobMetadata.metadata as { serviceCancelledBeforeLaunch?: boolean })?.serviceCancelledBeforeLaunch)) {
    cancellation.stop();
    return; // A delayed RunTask must not start portal work after launch was cancelled.
  }
  const expectedRefs = serviceJobMetadata ? await loadServiceExpectedRefs(serviceJobMetadata) : [];
  const outputBucket = serviceJobMetadata?.outputBucket;
  const manifestKey = serviceJobMetadata ? workerResultManifestKey(serviceJobMetadata.outputPrefix) : null;
  const initialManifest = outputBucket && manifestKey ? await (async () => {
    try {
      const object = await getS3Client().send(new GetObjectCommand({ Bucket: outputBucket, Key: manifestKey }));
      if (!object.Body) throw new Error("Worker results are empty.");
      return validateWorkerManifest(JSON.parse(await object.Body.transformToString()), jobId, expectedRefs);
    } catch (error) {
      const missing = error as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (missing.name === "NoSuchKey" || missing.$metadata?.httpStatusCode === 404) return null;
      throw error;
    }
  })() : null;
  const resultPublisher = isServiceJob ? createClaimResultPublisher({ jobId, expectedRefs, initial: initialManifest,
    save: async manifest => {
      if (!outputBucket || !manifestKey) throw new Error("Worker result storage is missing.");
      await getS3Client().send(new PutObjectCommand({ Bucket: outputBucket, Key: manifestKey,
        Body: JSON.stringify(manifest), ContentType: "application/json" }));
      const committed = await publishWorkerResultSnapshot(jobId, portalId, expectedRefs, manifest);
      const progress = { type: "progress", completed: committed.processed, total: expectedRefs.length };
      await publishWorkflowEvent(jobId, progress).catch(() => {});
    },
  }) : null;
  await resultPublisher?.initialize();
  if (iehpOutputWorkbook) iehpOutputWorkbook.publish = resultPublisher?.publishWorkbook;
  if (isServiceJob && iehpOutputWorkbook) {
    const serviceJob = await getWorkflowJobById(jobId);
    if (!serviceJob) throw new Error("Integrated job metadata is missing.");
    iehpOutputWorkbook.outputKey = serviceOutputWorkbookLocation(serviceJob).key;
  }
  let lastIehpSnapshotCompleted = 0;
  let lastIehpSnapshotAt = 0;
  let lastUhcSnapshotCompleted = 0;
  let lastUhcSnapshotAt = 0;
  let uhcRowsUpdated = 0;
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
      if (portalId === "iehp" && event.type === "done") return;
      if ((event.type === "log" || event.type === "warning" || event.type === "error") && typeof event.message === "string") {
        writeCloudWatchLog({ jobId, workflowId, portalId, message: event.message,
          level: typeof event.level === "string" ? event.level : event.type === "error" ? "error" : "info" });
      }
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
      if (uhcOutputWorkbook && isClaimRowUpdateEvent(event as Record<string, unknown>)) {
        applyUhcRowUpdateToWorksheet(uhcOutputWorkbook.worksheet, event);
        uhcOutputWorkbook.changed = true;
        uhcRowsUpdated += 1;
      }
      try {
        const persistentEvent = resultPublisher && (event.type === "progress" || event.type === "row_progress")
          ? { ...event, completed: resultPublisher.getSnapshot().results.length, total: expectedRefs.length } : event;
        await persistEvent(job.id, persistentEvent, {
          publishWorkbook: resultPublisher?.publishWorkbook,
          requireArtifactUpload: isServiceJob && (event.type === "output_snapshot" ||
            (event.type === "file_download" && typeof event.filename === "string" && event.filename.toLowerCase().endsWith(".xlsx"))),
        });
      } catch (error) {
        if (portalId === "iehp" && event.type === "pdf_download") {
          scraperErrorMessage = `IEHP RA PDF storage failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        throw error;
      }
      if (portalId === "iehp" && event.type === "pdf_download" && typeof event.path === "string") {
        await fs.unlink(event.path).catch(() => {});
      }
      if (
        portalId === "iehp" &&
        iehpOutputWorkbook?.changed &&
        typeof event === "object" &&
        event !== null &&
        "type" in event &&
        event.type === "progress"
      ) {
        const completed = getScrapeJob(job.id)?.currentCompleted ?? 0;
        if (completed > lastIehpSnapshotCompleted && Date.now() - lastIehpSnapshotAt >= 10_000) {
          const saved = await uploadClaimOutputWorkbook(jobId, iehpOutputWorkbook, {
            portalId: "iehp",
            finalize: false,
            announce: false,
          }).catch((uploadError) => {
            console.error("IEHP partial workbook snapshot upload failed", uploadError);
            return false;
          });
          if (saved) {
            lastIehpSnapshotCompleted = completed;
            lastIehpSnapshotAt = Date.now();
            iehpOutputWorkbook.changed = false;
          }
        }
      }
      if (portalId === "uhc" && uhcOutputWorkbook?.changed && event.type === "progress") {
        const completed = getScrapeJob(job.id)?.currentCompleted ?? 0;
        if (completed > lastUhcSnapshotCompleted && Date.now() - lastUhcSnapshotAt >= 10_000) {
          const saved = await uploadClaimOutputWorkbook(jobId, uhcOutputWorkbook, {
            portalId: "uhc", finalize: false, announce: false,
          }).catch((uploadError) => {
            console.error("UHC partial workbook snapshot upload failed", uploadError);
            return false;
          });
          if (saved) {
            lastUhcSnapshotCompleted = completed;
            lastUhcSnapshotAt = Date.now();
            uhcOutputWorkbook.changed = false;
          }
        }
      }
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
      if (event.level === "error" && event.rowIndex === undefined && !scraperErrorMessage) {
        scraperErrorMessage = event.message;
      }
      emitScrapeJobEvent(job.id, payload);
      await persistEvent(job.id, payload);
    },
  };

  try {
    if (portalId === "uhc") {
      uhcOutputWorkbook = await buildUhcOutputWorkbook(formData);
      uhcOutputWorkbook.publish = resultPublisher?.publishWorkbook;
    }
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
    if (portalId === "uhc" && completed > 0 && uhcRowsUpdated === 0) {
      throw new Error("UHC reported completed rows without any claim output updates.");
    }
    const uploadedIehpOutput = portalId === "iehp"
      ? await uploadClaimOutputWorkbook(jobId, iehpOutputWorkbook, { portalId: "iehp" })
      : false;
    if (portalId === "uhc" && uhcOutputWorkbook && uhcRowsUpdated > 0) {
      await uploadClaimOutputWorkbook(jobId, uhcOutputWorkbook, {
        portalId: "uhc", finalize: runResult !== "cancelled",
      });
    }
    await resultPublisher?.finish(runResult === "cancelled" || cancellation.isCancelled() ? "CANCELLED" : "OUTPUT_MISSING");
    const serviceSummary = resultPublisher
      ? workerManifestSummary(resultPublisher.getSnapshot(), expectedRefs)
      : null;
    if (isServiceJob && !serviceSummary) {
      throw new Error("Integrated output workbook could not be validated.");
    }
    const status: PersistentScrapeJobStatus = runResult === "cancelled" || cancellation.isCancelled()
      ? "cancelled"
      : total > 0 && completed < total
        ? "waiting_resume"
        : "completed";
    if (status === "completed" && portalId === "iehp" && !uploadedIehpOutput) {
      throw new Error("IEHP worker completed without producing an output workbook artifact.");
    }
    await cacheJobArtifacts(jobId);
    const awsStatus: AwsWorkflowJobStatus = status === "cancelled" ? (isServiceJob ? "cancelling" : "cancelled") : serviceSummary
      ? serviceSummary.outcome === "SUCCESS" ? "completed" : serviceSummary.outcome === "PARTIAL_SUCCESS" ? "partial_success" : "failed"
      : status === "waiting_resume" ? "failed" : status;
    const finalProgress = resultPublisher ? { currentCompleted: resultPublisher.getSnapshot().results.length, totalRows: expectedRefs.length }
      : { currentCompleted: completed, totalRows: total };
    await updateWorkflowJob({ jobId, status: awsStatus, ...(!resultPublisher ? finalProgress : {}) }).catch(() => {});
    await updateScrapeJobSnapshot({ jobId, status, ...finalProgress }).catch(() => {});
    const finalEvent = { type: awsStatus === "cancelling" ? "cancelling" : awsStatus === "cancelled" ? "cancelled" : awsStatus === "failed" ? "failed" : awsStatus === "partial_success" ? "partial_success" : "completed" };
    const finalEventId = await appendWorkflowEvent(jobId, finalEvent.type, finalEvent).catch(() => null);
    await publishWorkflowEvent(jobId, finalEvent, finalEventId).catch(() => {});
    const doneEvent = { type: "done" };
    emitScrapeJobEvent(job.id, doneEvent);
    await publishWorkflowEvent(jobId, doneEvent).catch(() => {});
    console.log(`Worker finished for ${portalId} job ${jobId} with status ${status}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected worker error.";
    let partialServiceResult = false;
    if (portalId === "iehp") {
      await uploadClaimOutputWorkbook(jobId, iehpOutputWorkbook, { portalId: "iehp" }).catch((uploadError) => {
        console.error("IEHP partial workbook upload failed", uploadError);
        return false;
      });
    }
    if (portalId === "uhc" && uhcOutputWorkbook && uhcRowsUpdated > 0) {
      await uploadClaimOutputWorkbook(jobId, uhcOutputWorkbook, { portalId: "uhc", finalize: false }).catch((uploadError) => {
        console.error("UHC partial workbook upload failed", uploadError);
      });
    }
    if (resultPublisher) {
      try {
        const manifest = await resultPublisher.finish(cancellation.isCancelled() ? "CANCELLED" : "OUTPUT_MISSING");
        partialServiceResult = workerManifestSummary(manifest, expectedRefs).counts.success > 0;
      } catch {
        // A storage failure is a job failure; never synthesize claim success.
        partialServiceResult = false;
      }
    }
    await cacheJobArtifacts(jobId);
    const cancellationStatus = cancellation.isCancelled() ? (isServiceJob ? "cancelling" : "cancelled") : partialServiceResult ? "partial_success" : "failed";
    const finalProgress = resultPublisher ? { currentCompleted: resultPublisher.getSnapshot().results.length, totalRows: expectedRefs.length }
      : { currentCompleted: getScrapeJob(job.id)?.currentCompleted ?? 0, totalRows: getScrapeJob(job.id)?.totalRows ?? 0 };
    await updateWorkflowJob({
      jobId,
      status: cancellationStatus,
      ...(!resultPublisher ? finalProgress : {}),
      errorMessage: message,
    }).catch(() => {});
    const failedEvent = { type: cancellationStatus, message };
    const failedEventId = await appendWorkflowEvent(jobId, failedEvent.type, failedEvent).catch(() => null);
    await publishWorkflowEvent(jobId, failedEvent, failedEventId).catch(() => {});
    await publishWorkflowEvent(jobId, { type: "done" }).catch(() => {});
    await updateScrapeJobSnapshot({
      jobId,
      status: cancellation.isCancelled() ? "cancelled" : "failed",
      ...finalProgress,
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
