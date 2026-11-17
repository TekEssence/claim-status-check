import test from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { artifactLocationId, emptyArtifactManifest, recordArtifact, manifestOutputs, persistArtifact, type ArtifactFile, type ArtifactManifest } from "./artifact-manifest";
import { listManifestFiles } from "./artifact-files";

const file = (name: string, artifactType = "pdf_download", id = 1): ArtifactFile => ({ id, artifactType, filename: name,
  bucket: "outputs", s3Key: `claim-status/job-A/output/${name}`, mimeType: "application/octet-stream", rowIndex: null,
  createdAt: "2026-11-17T00:00:00Z" });

test("overwrites keep unique counts, new files increment counts, and revisions invalidate downloads", () => {
  const manifest = emptyArtifactManifest();
  recordArtifact(manifest, file("claim.pdf"), "job-A");
  recordArtifact(manifest, file("claim.pdf", "pdf_download", 2), "job-A");
  assert.equal(manifest.count, 1); assert.equal(manifest.revision, 2);
  recordArtifact(manifest, file("screen.png", "error_screenshot", 3), "job-A");
  assert.equal(manifest.count, 2);
  const folder = Object.values(manifest.folders)[0];
  assert.deepEqual(folder.counts, { pdf_download: 1, error_screenshot: 1 });
  recordArtifact(manifest, file("claim.pdf", "file_download", 4), "job-A");
  assert.equal(manifest.count, 2);
  assert.deepEqual(folder.counts, { file_download: 1, error_screenshot: 1 });
  assert.deepEqual(manifest.outputs, {}); // PDFs/screenshots have no per-file name records.
});

test("multiple dates/buckets preserve locations and AR workbook references", () => {
  const manifest = emptyArtifactManifest();
  recordArtifact(manifest, file("claims.xlsx", "output_snapshot", 10), "job-A");
  recordArtifact(manifest, { ...file("claims.xlsx", "output_snapshot", 11), bucket: "other-output-bucket" }, "job-A");
  recordArtifact(manifest, { ...file("claim.pdf"), s3Key: "claim-status/2026-11-18/job-A/output/claim.pdf" }, "job-A");
  assert.equal(Object.keys(manifest.folders).length, 3);
  assert.equal(manifest.count, 3);
  assert.deepEqual(manifestOutputs(manifest).map(row => row.id), [11, 10]);
  assert.throws(() => recordArtifact(manifest, file("other.pdf"), "another-job"), /must belong/);
});

test("folder listing paginates, includes all registered files, and ignores unrelated objects", async () => {
  const manifest = emptyArtifactManifest();
  recordArtifact(manifest, file("claim.pdf"), "job-A");
  recordArtifact(manifest, file("screen.png", "error_screenshot"), "job-A");
  const tokens: Array<string | undefined> = [];
  const client = { async send(command: ListObjectsV2Command) {
    tokens.push(command.input.ContinuationToken);
    return command.input.ContinuationToken ? { Contents: [{ Key: file("screen.png").s3Key }] }
      : { Contents: [{ Key: file("claim.pdf").s3Key }, { Key: file("internal.json").s3Key }], IsTruncated: true, NextContinuationToken: "page-2" };
  } } as unknown as S3Client;
  const files = await listManifestFiles("job-A", manifest, client);
  assert.deepEqual(tokens, [undefined, "page-2"]);
  assert.deepEqual(files.map(file => file.filename).sort(), ["claim.pdf", "screen.png"]);
  await assert.rejects(listManifestFiles("another-job", manifest, client), /must belong/);
});

test("missing files and incomplete pagination fail instead of silently omitting files", async () => {
  const manifest = recordArtifact(emptyArtifactManifest(), file("claim.pdf"), "job-A");
  const empty = { send: async () => ({ Contents: [] }) } as unknown as S3Client;
  await assert.rejects(listManifestFiles("job-A", manifest, empty), /missing from S3/);
  const incomplete = { send: async () => ({ IsTruncated: true }) } as unknown as S3Client;
  await assert.rejects(listManifestFiles("job-A", manifest, incomplete), /incomplete/);
});

test("the persistence path locks the job before reading and upserts a single summary", async () => {
  let stored: ArtifactManifest | null = null;
  let calls: string[] = [];
  const client = { async query(query: string, args: unknown[]) {
    calls.push(query);
    if (query.startsWith("SELECT job_id")) return { rowCount: 1, rows: [{ job_id: "job-A" }] };
    if (query.startsWith("SELECT manifest")) return { rows: stored ? [{ manifest: structuredClone(stored) }] : [] };
    assert.match(query, /ON CONFLICT\(job_id\) DO UPDATE/);
    stored = JSON.parse(args[7] as string);
    return { rowCount: 1, rows: [] };
  } } as unknown as Pick<PoolClient, "query">;
  const input = { jobId: "job-A", ...file("claim.pdf") };
  await persistArtifact(client, input);
  assert.match(calls[0], /FOR UPDATE/);
  calls = [];
  await persistArtifact(client, input);
  assert.equal(stored!.count, 1);
  assert.equal(Object.keys(Object.values(stored!.folders)[0].objects)[0], artifactLocationId(input.bucket, input.s3Key));
  assert.equal(stored!.revision, 2);
});
