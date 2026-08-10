import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import ExcelJS from "exceljs";
import { cancelScrapeJob, createScrapeJob, emitScrapeJobEvent, getScrapeJob, submitScrapeJobInput } from "@/backend/src/jobs/job-store";
import {
  uploadWorkflowArtifact,
} from "@/backend/src/core/workflow-s3-storage";
import { getClaimStatusScraper } from "@/backend/src/workflows/claim-status/registry";
import type { ScraperContext } from "@/backend/src/workflows/claim-status/types";
import {
  applyClaimRowUpdateToWorksheet,
  postProcessWorksheet,
  type ClaimRowUpdateEvent,
} from "@/backend/src/workflows/claim-status/portals/iehp/workbook-output";
import { runDbWithRetry } from "@/db";
import { scrapeJobs } from "@/db/schema/scrape-jobs";
import {
  appendWorkflowEvent,
  appendWorkflowArtifact,
  consumePendingWorkflowCommands,
  listArtifactsForJob,
  updateWorkflowJob,
  type AwsWorkflowJobStatus,
} from "@/backend/src/aws/runtime/workflow-db";
import { publishWorkflowEvent } from "@/backend/src/aws/runtime/websocket-publisher";
import {
  appendScrapeJobArtifact,
  appendScrapeJobLog,
  createPersistentScrapeJob,
  updateScrapeJobSnapshot,
  type PersistentScrapeJobStatus,
} from "@/lib/scrape-jobs/db";

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

  const eventId = await appendWorkflowEvent(jobId, String(data.type ?? "event"), data).catch(() => null);
  await publishWorkflowEvent(jobId, data, eventId).catch(() => {});

  if (data.type === "log" && typeof data.message === "string" && data.message.trim()) {
    await appendScrapeJobLog(jobId, data.message).catch(() => {});
    return;
  }

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

function startCancellationPoll(jobId: string): { isCancelled: () => boolean; stop: () => void } {
  if (!hasDatabase()) return { isCancelled: () => false, stop: () => {} };

  let cancelled = false;
  const timer = setInterval(() => {
    void Promise.all([
      runDbWithRetry((db) =>
        db.select({ status: scrapeJobs.status }).from(scrapeJobs).where(eq(scrapeJobs.jobId, jobId)).limit(1),
      ).then((rows) => {
        cancelled = rows[0]?.status === "cancelled";
      }),
      consumePendingWorkflowCommands(jobId).then((commands) => {
        for (const command of commands) {
          if (command.commandType === "cancel") {
            cancelled = true;
            cancelScrapeJob(jobId, "Cancellation requested.");
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
    ]).catch(() => {});
  }, 3000);

  return {
    isCancelled: () => cancelled,
    stop: () => clearInterval(timer),
  };
}

export async function main(): Promise<void> {
  const jobId = requiredEnv("JOB_ID");
  const portalId = requiredEnv("PORTAL_ID");
  const userId = optionalEnv("USER_ID");
  const formData = await buildFormData(portalId);
  const scraper = getClaimStatusScraper(portalId);
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
      console.log(`[${event.level ?? "info"}] ${event.message}`);
      emitScrapeJobEvent(job.id, payload);
      await persistEvent(job.id, payload);
    },
  };

  try {
    await scraper.run(input, context);
    if (scraperErrorMessage) {
      throw new Error(scraperErrorMessage);
    }
    const currentJob = getScrapeJob(job.id);
    const completed = currentJob?.currentCompleted ?? 0;
    const total = currentJob?.totalRows ?? 0;
    const uploadedIehpOutput = portalId === "iehp"
      ? await uploadIehpOutputWorkbook(jobId, iehpOutputWorkbook)
      : false;
    const artifactCount = hasDatabase() ? await listArtifactsForJob(jobId).then((artifacts) => artifacts.length).catch(() => 0) : 0;
    const status: PersistentScrapeJobStatus = cancellation.isCancelled()
      ? "cancelled"
      : total > 0 && completed < total
        ? "waiting_resume"
        : "completed";
    if (status === "completed" && portalId === "iehp" && !uploadedIehpOutput && artifactCount === 0) {
      throw new Error("IEHP worker completed without producing an output workbook artifact.");
    }
    const awsStatus: AwsWorkflowJobStatus = status === "waiting_resume" ? "failed" : status;
    await updateWorkflowJob({ jobId, status: awsStatus, currentCompleted: completed, totalRows: total }).catch(() => {});
    await updateScrapeJobSnapshot({ jobId, status, currentCompleted: completed, totalRows: total }).catch(() => {});
    const finalEvent = { type: status === "cancelled" ? "cancelled" : "completed" };
    const finalEventId = await appendWorkflowEvent(jobId, "completed", finalEvent).catch(() => null);
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
    await appendScrapeJobLog(jobId, `ERROR: ${message}`).catch(() => {});
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
