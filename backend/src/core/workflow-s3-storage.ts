import fs from "node:fs/promises";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { WorkflowId } from "@/backend/src/workflows/types";

type WorkflowStorageArea = "input" | "output";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    s3Client = new S3Client({});
  }
  return s3Client;
}

function getBucketName(): string {
  return String(process.env.WORKFLOW_OUTPUTS_BUCKET ?? "").trim();
}

export function isWorkflowS3StorageEnabled(): boolean {
  return Boolean(getBucketName());
}

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)
    .join("_")
    .replace(/[^a-zA-Z0-9._=-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "file";
}

function datePrefix(now = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}/${dd}`;
}

export function buildWorkflowS3Key(options: {
  workflowId: WorkflowId;
  jobId: string;
  area: WorkflowStorageArea;
  filename: string;
  now?: Date;
}): string {
  return [
    options.workflowId,
    datePrefix(options.now),
    sanitizePathSegment(options.jobId),
    options.area,
    sanitizePathSegment(options.filename),
  ].join("/");
}

async function uploadWorkflowObject(options: {
  key: string;
  body: Buffer | Uint8Array | string;
  contentType?: string;
}): Promise<string> {
  const bucket = getBucketName();
  if (!bucket) return "";

  await getS3Client().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: options.key,
      Body: options.body,
      ContentType: options.contentType,
    }),
  );

  return options.key;
}

export async function uploadWorkflowFile(options: {
  workflowId: WorkflowId;
  jobId: string;
  area: WorkflowStorageArea;
  file: File;
  fallbackName: string;
}): Promise<string> {
  if (!isWorkflowS3StorageEnabled()) return "";
  const filename = options.file.name || options.fallbackName;
  const key = buildWorkflowS3Key({
    workflowId: options.workflowId,
    jobId: options.jobId,
    area: options.area,
    filename,
  });

  return uploadWorkflowObject({
    key,
    body: new Uint8Array(await options.file.arrayBuffer()),
    contentType: options.file.type || contentTypeForFilename(filename),
  });
}

export async function uploadWorkflowJson(options: {
  workflowId: WorkflowId;
  jobId: string;
  area: WorkflowStorageArea;
  filename: string;
  value: unknown;
}): Promise<string> {
  if (!isWorkflowS3StorageEnabled()) return "";
  const key = buildWorkflowS3Key(options);
  return uploadWorkflowObject({
    key,
    body: JSON.stringify(options.value, null, 2),
    contentType: "application/json",
  });
}

export async function uploadWorkflowArtifact(options: {
  workflowId: WorkflowId;
  jobId: string;
  filename: string;
  artifactType: string;
  path?: string;
  base64?: string;
  text?: string;
  mimeType?: string;
}): Promise<string> {
  if (!isWorkflowS3StorageEnabled()) return "";

  const filename = options.filename || fallbackArtifactFilename(options.artifactType);
  const key = buildWorkflowS3Key({
    workflowId: options.workflowId,
    jobId: options.jobId,
    area: "output",
    filename,
  });

  if (options.base64) {
    return uploadWorkflowObject({
      key,
      body: Buffer.from(options.base64, "base64"),
      contentType: options.mimeType || contentTypeForFilename(filename),
    });
  }

  if (options.text) {
    return uploadWorkflowObject({
      key,
      body: options.text,
      contentType: options.mimeType || "text/plain",
    });
  }

  if (options.path) {
    return uploadWorkflowObject({
      key,
      body: await fs.readFile(options.path),
      contentType: options.mimeType || contentTypeForFilename(path.basename(options.path)),
    });
  }

  return "";
}

function fallbackArtifactFilename(artifactType: string): string {
  if (artifactType === "debug_html") return `debug_${Date.now()}.html`;
  if (artifactType === "error_screenshot") return `screenshot_${Date.now()}.jpg`;
  if (artifactType === "pdf_download") return `download_${Date.now()}.pdf`;
  return `artifact_${Date.now()}.bin`;
}

function contentTypeForFilename(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".xls") return "application/vnd.ms-excel";
  if (ext === ".csv") return "text/csv";
  if (ext === ".json") return "application/json";
  if (ext === ".html") return "text/html";
  if (ext === ".txt" || ext === ".log") return "text/plain";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  return undefined;
}
