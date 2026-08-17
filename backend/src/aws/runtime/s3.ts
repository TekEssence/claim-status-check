import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

let client: S3Client | null = null;

function s3(): S3Client {
  if (!client) client = new S3Client({});
  return client;
}

export function buildWorkflowKey(params: {
  workflowId: string;
  jobId: string;
  area: "input" | "output";
  filename: string;
}) {
  const safeName = params.filename.replace(/\\/g, "/").split("/").filter(Boolean).pop() || "file";
  const date = new Date().toISOString().slice(0, 10);
  return `${params.workflowId}/${date}/${params.jobId}/${params.area}/${safeName.replace(/[^a-zA-Z0-9._=-]+/g, "_")}`;
}

export async function createUploadUrl(params: {
  bucket: string;
  key: string;
  contentType?: string;
}) {
  return getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      ContentType: params.contentType || "application/octet-stream",
    }),
    { expiresIn: 900 },
  );
}

export async function createDownloadUrl(params: {
  bucket: string;
  key: string;
  filename?: string;
  contentType?: string;
}) {
  const safeFilename = params.filename?.replace(/["\r\n]/g, "") || "download";
  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: params.bucket,
      Key: params.key,
      ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
      ResponseContentType: params.contentType || "application/octet-stream",
    }),
    { expiresIn: 300 },
  );
}
