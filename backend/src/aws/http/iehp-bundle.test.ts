import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, GetObjectCommand, UploadPartCommand, type S3Client } from "@aws-sdk/client-s3";
import { createIehpBundle, selectIehpBundleEntries, type IehpArtifact } from "./iehp-bundle";

const artifact = (id: number, artifactType: string, filename: string): IehpArtifact => ({
  id, artifactType, filename, bucket: "outputs", s3Key: `claim-status/run/output/${filename}`,
});

test("IEHP bundle selects the latest workbook and all distinct RA PDFs", () => {
  const entries = selectIehpBundleEntries([
    artifact(1, "output_snapshot", "claims_output.xlsx"),
    artifact(2, "pdf_download", "claim_ra_2_member_check.pdf"),
    artifact(3, "pdf_download", "covered_ra_3_member_check.pdf"),
    artifact(4, "output_snapshot", "claims_output.xlsx"),
    artifact(5, "pdf_download", "claim_ra_2_member_check.pdf"),
    artifact(6, "file_download", "old_bundle.zip"),
  ]);
  assert.deepEqual(entries.map((entry) => [entry.artifact.id, entry.name]), [
    [5, "ra/claim/claim_ra_2_member_check.pdf"],
    [3, "ra/covered/covered_ra_3_member_check.pdf"],
    [4, "results/claims_output.xlsx"],
  ]);
});

test("IEHP creates a partial ZIP in S3 and reuses it until a source changes", async () => {
  const sources = [artifact(1, "output_snapshot", "claims_output.xlsx"), artifact(2, "pdf_download", "claim_ra_2_check.pdf")];
  const bodies = new Map(sources.map((source) => [source.s3Key, Buffer.from(source.filename)]));
  let zip = Buffer.alloc(0);
  let getCount = 0;
  let recorded = 0;
  let completed = false;
  const client = {
    async send(command: GetObjectCommand | CreateMultipartUploadCommand | UploadPartCommand | CompleteMultipartUploadCommand) {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-1" };
      if (command instanceof GetObjectCommand) {
        getCount += 1;
        const body = bodies.get(command.input.Key!);
        assert.ok(body);
        return { Body: Readable.from([body]) };
      }
      if (command instanceof UploadPartCommand) {
        zip = Buffer.concat([zip, Buffer.from(command.input.Body as Buffer)]);
        return { ETag: `part-${command.input.PartNumber}` };
      }
      assert.deepEqual(command.input.MultipartUpload?.Parts, [{ ETag: "part-1", PartNumber: 1 }]);
      completed = true;
      return {};
    },
  } as unknown as S3Client;
  const recordArtifact = async () => { recorded += 1; };
  const result = await createIehpBundle({ jobId: "job-1", artifacts: sources, partial: true, client, recordArtifact });
  assert.equal(result?.filename, "iehp_job-1_partial.zip");
  assert.equal(recorded, 1);
  assert.equal(completed, true);
  assert.equal(getCount, 2);
  assert.equal(zip.readUInt32LE(0), 0x04034b50);
  assert.ok(zip.includes(Buffer.from("results/claims_output.xlsx")));
  assert.ok(zip.includes(Buffer.from("ra/claim/claim_ra_2_check.pdf")));
  assert.ok(zip.includes(Buffer.from("claim_ra_2_check.pdf")));

  const cached = await createIehpBundle({
    jobId: "job-1", artifacts: [...sources, artifact(3, "file_download", result!.filename)], partial: true, client, recordArtifact,
  });
  assert.equal(cached?.filename, result?.filename);
  assert.equal(getCount, 2);
  assert.equal(recorded, 1);
});

test("IEHP does not publish a ZIP when an S3 source cannot be read", async () => {
  let uploaded = false;
  let aborted = false;
  const client = {
    async send(command: GetObjectCommand | CreateMultipartUploadCommand | UploadPartCommand | CompleteMultipartUploadCommand | AbortMultipartUploadCommand) {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-2" };
      if (command instanceof GetObjectCommand) throw new Error("S3 read failed");
      if (command instanceof AbortMultipartUploadCommand) aborted = true;
      if (command instanceof CompleteMultipartUploadCommand) uploaded = true;
      return {};
    },
  } as unknown as S3Client;
  await assert.rejects(
    createIehpBundle({ jobId: "job-2", artifacts: [artifact(1, "pdf_download", "claim_ra_2.pdf")], partial: true, client, recordArtifact: async () => {} }),
    /S3 read failed/,
  );
  assert.equal(uploaded, false);
  assert.equal(aborted, true);
});

test("IEHP splits a large ZIP into bounded multipart uploads", async () => {
  const sizes: number[] = [];
  const client = {
    async send(command: GetObjectCommand | CreateMultipartUploadCommand | UploadPartCommand | CompleteMultipartUploadCommand) {
      if (command instanceof CreateMultipartUploadCommand) return { UploadId: "upload-3" };
      if (command instanceof GetObjectCommand) return { Body: Readable.from([Buffer.alloc(9 * 1024 * 1024, 0xab)]) };
      if (command instanceof UploadPartCommand) {
        sizes.push((command.input.Body as Buffer).length);
        return { ETag: `part-${command.input.PartNumber}` };
      }
      assert.equal(command.input.MultipartUpload?.Parts?.length, 2);
      return {};
    },
  } as unknown as S3Client;
  await createIehpBundle({ jobId: "job-3", artifacts: [artifact(1, "pdf_download", "claim_ra_2.pdf")], partial: true, client, recordArtifact: async () => {} });
  assert.equal(sizes[0], 8 * 1024 * 1024);
  assert.ok(sizes[1] > 0 && sizes[1] < 8 * 1024 * 1024);
});
