import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { listArtifactsForJob } from "../runtime/workflow-db";
import { loadServiceExpectedRefs, type ServiceWorkbookArtifact } from "./iehp-snapshot";
import { normalizeEligibilityServiceWorkbook } from "./eligibility-results";
import type { ServiceResultSummary } from "./iehp-results";

type ServiceJob = Parameters<typeof loadServiceExpectedRefs>[0];
let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client({});
  return client;
}

export async function loadEligibilityServiceSnapshot(
  job: ServiceJob,
): Promise<{ expectedRefs: string[]; summary: ServiceResultSummary | null; artifact: ServiceWorkbookArtifact | null; recorded: boolean }> {
  const [expectedRefs, artifacts] = await Promise.all([loadServiceExpectedRefs(job), listArtifactsForJob(job.jobId)]);
  const output = artifacts.find((item) =>
    (item.artifactType === "output_snapshot" || item.artifactType === "file_download")
    && item.bucket && item.s3Key && item.filename === "medrevenue-availity-eligibility-output.xlsx",
  );
  if (!output?.bucket || !output.s3Key) return { expectedRefs, summary: null, artifact: null, recorded: false };
  const object = await s3().send(new GetObjectCommand({ Bucket: output.bucket, Key: output.s3Key }));
  if (!object.Body) throw new Error("Eligibility output workbook is empty.");
  const bytes = await object.Body.transformToByteArray();
  if (!bytes.length) throw new Error("Eligibility output workbook is empty.");
  return {
    expectedRefs,
    summary: await normalizeEligibilityServiceWorkbook(bytes, expectedRefs),
    artifact: {
      bucket: output.bucket,
      object_key: output.s3Key,
      artifact_type: "output_snapshot",
      filename: output.filename,
      size_bytes: object.ContentLength ?? bytes.length,
      etag: object.ETag ?? null,
    },
    recorded: output.artifactType === "output_snapshot",
  };
}
