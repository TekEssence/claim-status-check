import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import archiver from "archiver";
import { buildWorkflowKey } from "../runtime/s3";
import { appendWorkflowArtifact } from "../runtime/workflow-db";

export type IehpArtifact = {
  id: number;
  artifactType: string;
  filename: string;
  bucket: string | null;
  s3Key: string;
  mimeType?: string | null;
};

type BundleEntry = { artifact: IehpArtifact; name: string };

function safeName(name: string): string {
  return path.basename(name.replace(/\\/g, "/")).replace(/[^a-zA-Z0-9._-]+/g, "_") || "file";
}

export function selectIehpBundleEntries(artifacts: IehpArtifact[]): BundleEntry[] {
  const newestFirst = [...artifacts].sort((a, b) => b.id - a.id);
  const workbook = newestFirst.find((item) =>
    item.artifactType === "output_snapshot" && item.filename.toLowerCase().endsWith(".xlsx") && item.bucket && item.s3Key);
  const entries: BundleEntry[] = workbook ? [{ artifact: workbook, name: `results/${safeName(workbook.filename)}` }] : [];
  const seen = new Set<string>();
  for (const item of newestFirst) {
    if (item.artifactType !== "pdf_download" || !item.filename.toLowerCase().endsWith(".pdf") || !item.bucket || !item.s3Key) continue;
    const area = item.filename.startsWith("covered_ra_") ? "covered" : "claim";
    const name = `ra/${area}/${safeName(item.filename)}`;
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ artifact: item, name });
  }
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

type ZipArchive = {
  append(stream: Readable, options: { name: string }): void;
  pipe(destination: PassThrough): void;
  finalize(): Promise<void>;
  on(event: "error" | "warning", listener: (error: Error) => void): void;
};

const createArchive = archiver as unknown as (format: "zip", options: { store: boolean }) => ZipArchive;
const PART_SIZE = 8 * 1024 * 1024;

async function uploadZipParts(params: {
  client: S3Client;
  output: PassThrough;
  bucket: string;
  key: string;
  uploadId: string;
}): Promise<Array<{ ETag: string; PartNumber: number }>> {
  const parts: Array<{ ETag: string; PartNumber: number }> = [];
  let chunks: Buffer[] = [];
  let pendingBytes = 0;
  const flush = async () => {
    if (pendingBytes === 0) return;
    const partNumber = parts.length + 1;
    if (partNumber > 10000) throw new Error("IEHP ZIP exceeds S3's 10,000-part multipart limit.");
    const body = Buffer.concat(chunks, pendingBytes);
    chunks = [];
    pendingBytes = 0;
    const response = await params.client.send(new UploadPartCommand({
      Bucket: params.bucket, Key: params.key, UploadId: params.uploadId,
      PartNumber: partNumber, Body: body, ContentLength: body.length,
    }));
    if (!response.ETag) throw new Error(`S3 did not return an ETag for IEHP ZIP part ${partNumber}.`);
    parts.push({ ETag: response.ETag, PartNumber: partNumber });
  };
  for await (const chunk of params.output) {
    const bytes = Buffer.from(chunk);
    for (let offset = 0; offset < bytes.length;) {
      const piece = bytes.subarray(offset, offset + PART_SIZE - pendingBytes);
      chunks.push(piece);
      pendingBytes += piece.length;
      offset += piece.length;
      if (pendingBytes === PART_SIZE) await flush();
    }
  }
  await flush();
  return parts;
}

export async function createIehpBundle(params: {
  jobId: string;
  artifacts: IehpArtifact[];
  partial: boolean;
  client?: S3Client;
  recordArtifact?: typeof appendWorkflowArtifact;
}): Promise<{ filename: string; bucket: string; s3Key: string } | null> {
  const entries = selectIehpBundleEntries(params.artifacts);
  if (entries.length === 0) return null;
  const bucket = entries[0].artifact.bucket;
  if (!bucket) throw new Error("IEHP output artifact is missing its S3 bucket.");
  const filename = `iehp_${safeName(params.jobId)}${params.partial ? "_partial" : ""}.zip`;
  const newestSourceId = entries.reduce((latest, entry) => Math.max(latest, entry.artifact.id), 0);
  const cached = params.artifacts.find((item) =>
    item.artifactType === "file_download" && item.filename === filename && item.bucket && item.s3Key && item.id > newestSourceId);
  if (cached?.bucket) return { filename, bucket: cached.bucket, s3Key: cached.s3Key };

  const client = params.client ?? new S3Client({});
  const s3Key = buildWorkflowKey({ workflowId: "claim-status", jobId: params.jobId, area: "output", filename });
  const multipart = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: s3Key, ContentType: "application/zip" }));
  if (!multipart.UploadId) throw new Error("S3 did not start the IEHP ZIP upload.");
  let completed = false;
  try {
    const output = new PassThrough();
    const archive = createArchive("zip", { store: true });
    archive.pipe(output);
    const archiveError = new Promise<never>((_, reject) => {
      archive.on("error", (error) => { output.destroy(error); reject(error); });
      archive.on("warning", (error) => { output.destroy(error); reject(error); });
    });
    for (const entry of entries) {
      const source = Readable.from((async function* () {
        const object = await client.send(new GetObjectCommand({ Bucket: entry.artifact.bucket!, Key: entry.artifact.s3Key }));
        if (!object.Body) throw new Error(`IEHP artifact ${entry.name} has no S3 body.`);
        for await (const chunk of object.Body as AsyncIterable<Uint8Array>) yield chunk;
      })());
      archive.append(source, { name: entry.name });
    }
    const uploading = uploadZipParts({ client, output, bucket, key: s3Key, uploadId: multipart.UploadId }).catch((error) => {
      output.destroy(error);
      throw error;
    });
    const parts = await Promise.race([Promise.all([archive.finalize(), uploading]).then(([, uploaded]) => uploaded), archiveError]);
    if (parts.length === 0) throw new Error("IEHP ZIP archive was empty.");
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket, Key: s3Key, UploadId: multipart.UploadId,
      MultipartUpload: { Parts: parts },
    }));
    completed = true;
    await (params.recordArtifact ?? appendWorkflowArtifact)({ jobId: params.jobId, artifactType: "file_download", filename, bucket, s3Key, mimeType: "application/zip" });
    return { filename, bucket, s3Key };
  } finally {
    if (!completed) {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: s3Key, UploadId: multipart.UploadId })).catch(() => {});
    }
  }
}
