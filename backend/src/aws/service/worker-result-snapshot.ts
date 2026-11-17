import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { loadServiceExpectedRefs, type ServiceWorkbookArtifact } from "./iehp-snapshot";
import type { ServiceResultSummary } from "./service-contract";
import { validateWorkerManifest, workerManifestSummary, workerResultManifestKey } from "./worker-result-contract";

type ServiceJob = Parameters<typeof loadServiceExpectedRefs>[0];
let client: S3Client | undefined;

/** Every Claim Status portal uses this loader. A legacy workbook is never
 * interpreted as execution evidence by Lambda. */
export async function loadWorkerResultSnapshot(job: ServiceJob, _options: { requireStatusColumns?: boolean } = {}, expectedRefsOverride?: string[]): Promise<{
  expectedRefs: string[]; summary: ServiceResultSummary | null; artifact: ServiceWorkbookArtifact | null; recorded: boolean;
}> {
  void _options; // Retained for registry callers; execution outcomes come from the worker manifest.
  const expectedRefs = expectedRefsOverride ?? await loadServiceExpectedRefs(job);
  if (!job.outputBucket) throw new Error("Worker result bucket is missing.");
  client ??= new S3Client({});
  let object;
  try {
    object = await client.send(new GetObjectCommand({ Bucket: job.outputBucket, Key: workerResultManifestKey(job.outputPrefix) }));
  } catch (error) {
    const missing = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (missing.name === "NoSuchKey" || missing.$metadata?.httpStatusCode === 404) {
      return { expectedRefs, summary: null, artifact: null, recorded: false };
    }
    throw error;
  }
  if (!object.Body) throw new Error("Worker results are empty.");
  const manifest = validateWorkerManifest(JSON.parse(await object.Body.transformToString()), job.jobId, expectedRefs);
  return { expectedRefs, summary: workerManifestSummary(manifest, expectedRefs), artifact: manifest.artifact, recorded: true };
}
