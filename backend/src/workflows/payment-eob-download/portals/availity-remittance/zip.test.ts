import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createStoredZipFromFolder } from "./zip";

test("creates a Payment EOB ZIP with nested PDF and output file paths", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "payment-eob-zip-"));
  try {
    await fs.mkdir(path.join(root, "PDFs"), { recursive: true });
    await fs.writeFile(path.join(root, "portal_remittance_results.csv"), "Check/EFT #\n0900562787\n", "utf8");
    await fs.writeFile(path.join(root, "payment_tracker.xlsx"), "tracker", "utf8");
    await fs.writeFile(path.join(root, "PDFs", "0900562787_2026-07-15.pdf"), "%PDF-test", "utf8");

    const zip = await createStoredZipFromFolder(root, "PaymentEobDownloads/2026-07-23/run-01");
    const text = zip.toString("latin1");

    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.match(text, /PaymentEobDownloads\/2026-07-23\/run-01\/portal_remittance_results\.csv/);
    assert.match(text, /PaymentEobDownloads\/2026-07-23\/run-01\/payment_tracker\.xlsx/);
    assert.match(text, /PaymentEobDownloads\/2026-07-23\/run-01\/PDFs\/0900562787_2026-07-15\.pdf/);
    assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
