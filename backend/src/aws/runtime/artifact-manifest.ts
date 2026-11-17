import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export type ArtifactFile = {
  id: number; artifactType: string; filename: string; bucket: string; s3Key: string;
  mimeType: string; rowIndex: number | null; createdAt: string;
};
export type ArtifactFolder = {
  bucket: string; prefix: string; count: number; counts: Record<string, number>;
  objects: Record<string, string>;
};
export type ArtifactManifest = {
  version: 1; revision: number; count: number;
  folders: Record<string, ArtifactFolder>; outputs: Record<string, ArtifactFile>;
};

export function artifactLocationId(bucket: string, key: string): string {
  return createHash("sha256").update(bucket).update("\n").update(key).digest("hex");
}

export function emptyArtifactManifest(): ArtifactManifest {
  return { version: 1, revision: 0, count: 0, folders: {}, outputs: {} };
}

/** Called under the job's DB row lock. Object identities make overwrites idempotent. */
export function recordArtifact(manifest: ArtifactManifest, file: ArtifactFile, jobId: string, requireJobPrefix = true): ArtifactManifest {
  if (!file.bucket || !file.s3Key || (requireJobPrefix && !file.s3Key.split("/").includes(jobId))) {
    throw new Error("Artifact location must belong to this job.");
  }
  const prefix = file.s3Key.slice(0, file.s3Key.lastIndexOf("/") + 1);
  const folderId = artifactLocationId(file.bucket, prefix);
  const objectId = artifactLocationId(file.bucket, file.s3Key);
  const folder = manifest.folders[folderId] ??= { bucket: file.bucket, prefix, count: 0, counts: {}, objects: {} };
  const previousType = folder.objects[objectId];
  if (!previousType) { folder.count += 1; manifest.count += 1; }
  if (previousType !== file.artifactType) {
    if (previousType && --folder.counts[previousType] === 0) delete folder.counts[previousType];
    folder.counts[file.artifactType] = (folder.counts[file.artifactType] ?? 0) + 1;
  }
  folder.objects[objectId] = file.artifactType;
  manifest.revision += 1;
  // AR still needs an exact workbook reference; PDFs/screenshots use folders.
  if (["output_snapshot", "file_download"].includes(file.artifactType)
    && !/\.(pdf|png|jpe?g|html?)$/i.test(file.filename)) {
    manifest.outputs[objectId] = file;
  } else delete manifest.outputs[objectId];
  return manifest;
}

export function manifestOutputs(manifest: ArtifactManifest): ArtifactFile[] {
  return Object.values(manifest.outputs).sort((a, b) => b.id - a.id);
}

export type ArtifactWrite = Pick<ArtifactFile, "artifactType" | "filename" | "bucket" | "s3Key"> & { jobId: string; mimeType?: string };

/** The caller owns the transaction. The job lock also covers the first artifact. */
export async function persistArtifact(client: Pick<PoolClient, "query">, input: ArtifactWrite): Promise<void> {
  const job = await client.query("SELECT job_id FROM workflow_jobs WHERE job_id=$1 FOR UPDATE", [input.jobId]);
  if (!job.rowCount) throw new Error("Artifact job does not exist.");
  const current = await client.query<{ manifest: ArtifactManifest }>("SELECT manifest FROM workflow_job_artifacts WHERE job_id=$1", [input.jobId]);
  const manifest = current.rows[0]?.manifest ?? emptyArtifactManifest();
  const { jobId, ...details } = input;
  const file: ArtifactFile = { ...details, id: manifest.revision + 1, mimeType: input.mimeType ?? "application/octet-stream",
    rowIndex: null, createdAt: new Date().toISOString() };
  recordArtifact(manifest, file, input.jobId);
  await client.query(`INSERT INTO workflow_job_artifacts
    (job_id,artifact_type,filename,s3_bucket,bucket,s3_key,mime_type,created_at,manifest)
    VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8::jsonb)
    ON CONFLICT(job_id) DO UPDATE SET manifest=EXCLUDED.manifest`,
    [input.jobId, file.artifactType, file.filename, file.bucket, file.s3Key, file.mimeType, file.createdAt, JSON.stringify(manifest)]);
}
