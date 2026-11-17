import fs from "node:fs/promises";
import path from "node:path";
import { getPool, runDbWithRetry } from "@/db";
import { automationJobArtifacts } from "@/db/schema/automation-jobs";
import { eq } from "drizzle-orm";
import { artifactLocationId, emptyArtifactManifest, manifestOutputs, recordArtifact, type ArtifactFile, type ArtifactManifest } from "@/backend/src/aws/runtime/artifact-manifest";
import { listManifestFiles } from "@/backend/src/aws/runtime/artifact-files";

type LocalArtifactRow = typeof automationJobArtifacts.$inferSelect;
export type LocalArtifactWrite = {
  jobId: string; rowIndex?: number | null; artifactType: string; filename?: string;
  mimeType?: string; pathOrKey?: string; metadata?: Record<string, unknown>;
};

export async function appendLocalArtifact(input: LocalArtifactWrite): Promise<void> {
  if (!input.pathOrKey) return; // Inline-only events remain available through SSE.
  const bucket = process.env.WORKFLOW_OUTPUTS_BUCKET && !path.isAbsolute(input.pathOrKey)
    ? process.env.WORKFLOW_OUTPUTS_BUCKET : "local";
  const key = bucket === "local" ? path.resolve(input.pathOrKey).replace(/\\/g, "/") : input.pathOrKey;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const job = await client.query("SELECT job_id FROM automation_jobs WHERE job_id=$1 FOR UPDATE", [input.jobId]);
    if (!job.rowCount) throw new Error("Artifact job does not exist.");
    const stored = await client.query<{ metadata_json: { artifactManifest?: ArtifactManifest } }>(
      "SELECT metadata_json FROM automation_job_artifacts WHERE job_id=$1", [input.jobId]);
    const manifest = stored.rows[0]?.metadata_json.artifactManifest ?? emptyArtifactManifest();
    const file: ArtifactFile = { id: manifest.revision + 1, artifactType: input.artifactType,
      filename: input.filename ?? path.basename(key), bucket, s3Key: key,
      mimeType: input.mimeType ?? "application/octet-stream", rowIndex: input.rowIndex ?? null, createdAt: new Date().toISOString() };
    recordArtifact(manifest, file, input.jobId, bucket !== "local");
    await client.query(`INSERT INTO automation_job_artifacts(job_id,artifact_type,filename,mime_type,path_or_key,metadata_json,created_at)
      VALUES($1,'artifact_folder',$2,'application/zip',$3,$4::jsonb,$5)
      ON CONFLICT(job_id) DO UPDATE SET metadata_json=EXCLUDED.metadata_json,path_or_key=EXCLUDED.path_or_key`,
      [input.jobId, `${input.jobId}-artifacts.zip`, key.slice(0, key.lastIndexOf("/") + 1),
        JSON.stringify({ artifactManifest: manifest }), file.createdAt]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { client.release(); }
}

/** Retain existing workbook fields for callers; other files use the folder summary. */
export function expandLocalArtifacts(row: LocalArtifactRow) {
  const manifest = row.metadataJson.artifactManifest as ArtifactManifest | undefined;
  const base = { ...row, metadataJson: {}, filename: row.filename ?? "", mimeType: row.mimeType ?? "", pathOrKey: row.pathOrKey ?? "" };
  if (!manifest) return [base];
  return [...manifestOutputs(manifest).map(file => ({ ...base, id: file.id, artifactType: file.artifactType,
    filename: file.filename, mimeType: file.mimeType, pathOrKey: file.s3Key, rowIndex: file.rowIndex, createdAt: file.createdAt })),
  { ...base, metadataJson: { count: manifest.count,
    folders: Object.values(manifest.folders).map(({ objects, ...folder }) => folder) } }];
}

export async function getLocalArtifactManifest(jobId: string): Promise<ArtifactManifest | null> {
  const rows = await runDbWithRetry(db => db.select({ metadata: automationJobArtifacts.metadataJson })
    .from(automationJobArtifacts).where(eq(automationJobArtifacts.jobId, jobId)));
  return rows[0]?.metadata.artifactManifest as ArtifactManifest ?? null;
}

export async function listLocalArtifactFiles(jobId: string, manifest: ArtifactManifest): Promise<ArtifactFile[]> {
  const local = Object.values(manifest.folders).filter(folder => folder.bucket === "local");
  const files: ArtifactFile[] = [];
  for (const folder of local) {
    const found = new Set<string>();
    for (const entry of await fs.readdir(folder.prefix, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const key = path.join(folder.prefix, entry.name).replace(/\\/g, "/");
      const id = artifactLocationId("local", key);
      if (!folder.objects[id]) continue;
      found.add(id);
      files.push(manifest.outputs[id] ?? { id: 0, artifactType: folder.objects[id], filename: entry.name,
        bucket: "local", s3Key: key, mimeType: "application/octet-stream", rowIndex: null, createdAt: "" });
    }
    if (found.size !== folder.count) throw new Error("Some local artifact files are missing; the download was not published.");
  }
  const s3Folders = Object.fromEntries(Object.entries(manifest.folders).filter(([, folder]) => folder.bucket !== "local"));
  if (Object.keys(s3Folders).length) files.push(...await listManifestFiles(jobId, { ...manifest, folders: s3Folders }));
  return files;
}
