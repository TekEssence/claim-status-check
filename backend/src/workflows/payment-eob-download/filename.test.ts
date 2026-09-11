import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { buildPaymentFilename, paymentFilename, paymentMode } from "./filename";
import { buildWaystarBulkPayments } from "./portals/waystar/output-builder";
import { createJopariAuditWorkbook } from "./portals/jopari/output";
import { parseInstamedRemittanceCsv } from "./portals/instamed-remittance/scraper";

const payment = { payer: "MCR", mode: "ACH", amount: "$6,761.32", number: "803561562", date: "08/26/2026" };

test("TAJ, GEH and GH use payer-first filenames and YYYYDDMM", () => {
  for (const group of ["TAJ", "GEH", " gh ", "GEH&#x20;"]) {
    assert.equal(buildPaymentFilename({ ...payment, group }), "MCR EFT $6761.32 803561562 20262608.pdf");
  }
});

test("other groups use date-first filenames without the check number", () => {
  for (const group of ["PSCD", "Posada", "BPH", "ESC", "WMGU", "TWL", "SSCE", "KS", "New Group", undefined]) {
    assert.equal(buildPaymentFilename({ ...payment, group, payer: "AARP", amount: "562.3", date: "2026-06-08" }), "06-08-26 AARP EFT $562.30.pdf");
  }
});

test("retains NON, zero amounts, leading zeros and real file extensions", () => {
  assert.equal(buildPaymentFilename({ ...payment, group: "TAJ", mode: "NON", amount: "0", number: "000123" }), "MCR NON $0.00 000123 20262608.pdf");
  assert.equal(buildPaymentFilename(payment, ".835"), "08-26-26 MCR EFT $6761.32.835");
});

test("handles InstaMed timestamp dates and payment method from its export", () => {
  const [record] = parseInstamedRemittanceCsv("Payer Name,Payment Date,Payment Method,Paid Amount,Check / EFT Trace #\nAARP,06/08/2026 12:00:00 AM,ACH,$562.30,00012");
  assert.equal(buildPaymentFilename({ payer: record.payer, date: record.checkDate, mode: paymentMode(record.raw), amount: record.amount }, ".txt"), "06-08-26 AARP EFT $562.30.txt");
});

test("does not invent missing payment fields or accept invalid calendar dates", () => {
  assert.equal(buildPaymentFilename({ group: "TAJ", date: "02/30/2026" }), "UnknownPayer UnknownMode UnknownAmount UnknownNumber UnknownDate.pdf");
  assert.equal(buildPaymentFilename({ ...payment, payer: "Payer/Name: A" }), "08-26-26 Payer-Name- A EFT $6761.32.pdf");
});

test("avoids overwriting different payments with identical filename fields", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "payment-filename-test-"));
  try {
    const first = await paymentFilename(folder, payment);
    await fs.writeFile(path.join(folder, first), "first payment");
    const second = await paymentFilename(folder, { ...payment, number: "999" });
    assert.equal(second, "08-26-26 MCR EFT $6761.32 (2).pdf");
    assert.equal(await fs.readFile(path.join(folder, first), "utf8"), "first payment");
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test("Waystar and Jopari outputs retain the exact saved PDF filename", async () => {
  const filename = buildPaymentFilename({ ...payment, group: "TAJ" });
  const waystar = await buildWaystarBulkPayments("ACH", [{ clientName: "TAJ", paymentType: "ACH", paymentNumber: payment.number, paymentAmount: payment.amount, paymentDate: payment.date, payer: payment.payer, pdfFileName: filename, downloadStatus: "DOWNLOAD_SUCCESS", archiveStatus: "NOT_ATTEMPTED", error: "" }]);
  const jopari = await createJopariAuditWorkbook([{ eftCheckNumber: payment.number, batchId: "", payDate: payment.date, claimsPaid: "1", paymentMethod: "ACH", billingTin: "", paidAmount: payment.amount, payer: payment.payer, comparison: "Unique", searchResult: "Found", downloadStatus: "Downloaded", filename, message: "" }]);
  for (const buffer of [waystar, jopari]) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(new Uint8Array(buffer).buffer);
    assert.ok((workbook.worksheets[0].getRow(2).values as unknown[]).includes(filename));
  }
});
