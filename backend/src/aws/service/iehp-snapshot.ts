import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { ServiceResultSummary } from "./service-contract";

type ServiceJob = {
  jobId: string;
  inputBucket: string | null;
  outputBucket: string | null;
  outputPrefix: string | null;
  claimFileName: string | null;
  metadata: unknown;
};

export function serviceOutputWorkbookLocation(job: Pick<ServiceJob, "outputPrefix" | "claimFileName">) {
  if (!job.outputPrefix) throw new Error("Integrated output prefix is missing.");
  const baseName = (job.claimFileName || "claims.xlsx").replace(/\.xlsx$/i, "");
  const filename = `${baseName}_output.xlsx`;
  return { filename, key: `${job.outputPrefix}/${filename}` };
}

export type ServiceWorkbookArtifact = {
  bucket: string;
  object_key: string;
  artifact_type: "output_snapshot";
  filename: string;
  size_bytes: number;
  etag: string | null;
};

let client: S3Client | null = null;
function s3(): S3Client {
  if (!client) client = new S3Client({});
  return client;
}

export async function loadServiceExpectedRefs(job: ServiceJob): Promise<string[]> {
  const metadata = job.metadata as { inputKeys?: { claimRows?: unknown } } | null;
  const key = metadata?.inputKeys?.claimRows;
  if (!job.inputBucket || typeof key !== "string" || !key) throw new Error("Integrated claim input reference is missing.");
  const object = await s3().send(new GetObjectCommand({ Bucket: job.inputBucket, Key: key }));
  if (!object.Body) throw new Error("Integrated claim input is empty.");
  const rows = JSON.parse(Buffer.from(await object.Body.transformToByteArray()).toString("utf8")) as Array<{ "Client Row Ref"?: unknown }>;
  if (!Array.isArray(rows) || !rows.length) throw new Error("Integrated claim input is invalid.");
  const refs = rows.map((row) => row?.["Client Row Ref"]);
  if (refs.some((ref) => typeof ref !== "string" || !ref) || new Set(refs).size !== refs.length) {
    throw new Error("Integrated claim row references are missing or duplicated.");
  }
  return refs as string[];
}

export async function loadIehpServiceSnapshot(
  job: ServiceJob,
  _options: { requireStatusColumns?: boolean } = {},
): Promise<{ expectedRefs: string[]; summary: ServiceResultSummary | null; artifact: ServiceWorkbookArtifact | null; recorded: boolean }> {
  void _options; // Retained for callers of the former workbook reader.
  // Compatibility export: old callers also use the single worker-only reader.
  const { loadWorkerResultSnapshot } = await import("./worker-result-snapshot");
  return loadWorkerResultSnapshot(job);
}
