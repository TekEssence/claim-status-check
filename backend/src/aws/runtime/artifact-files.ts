import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { artifactLocationId, type ArtifactFile, type ArtifactManifest } from "./artifact-manifest";

/** S3 listing happens on downloads/bundling, never on ordinary job polling. */
export async function listManifestFiles(jobId: string, manifest: ArtifactManifest, client = new S3Client({})): Promise<ArtifactFile[]> {
  const files: ArtifactFile[] = [];
  for (const folder of Object.values(manifest.folders)) {
    if (!folder.prefix.endsWith("/") || !folder.prefix.split("/").includes(jobId)) {
      throw new Error("Artifact folder must belong to the requested job.");
    }
    let token: string | undefined;
    const found = new Set<string>();
    do {
      const page = await client.send(new ListObjectsV2Command({ Bucket: folder.bucket, Prefix: folder.prefix, ContinuationToken: token }));
      for (const object of page.Contents ?? []) {
        if (!object.Key) continue;
        const id = artifactLocationId(folder.bucket, object.Key);
        const artifactType = folder.objects[id];
        if (!artifactType || found.has(id)) continue;
        found.add(id);
        const filename = object.Key.split("/").pop()!;
        files.push(manifest.outputs[id] ?? { id: 0, bucket: folder.bucket, s3Key: object.Key, artifactType, filename,
          mimeType: filename.endsWith(".pdf") ? "application/pdf" : "application/octet-stream",
          rowIndex: null, createdAt: object.LastModified?.toISOString() ?? "" });
      }
      if (page.IsTruncated && !page.NextContinuationToken) throw new Error("Artifact folder listing is incomplete.");
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    if (found.size !== folder.count) throw new Error("Some registered artifact files are missing from S3; the download was not published.");
  }
  return files.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
