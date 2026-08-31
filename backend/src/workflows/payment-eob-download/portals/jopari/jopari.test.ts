import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { existsInControlLog, parseJopariExport } from "./scraper";
import { createJopariAuditWorkbook } from "./output";

async function exportWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet0");
  sheet.addRow(["EFT_Check", "Batch_ID", "Pay_Date", "Claims_Paid", "Payment_Method", "Billing_TIN", "Paid_Amount", "Payer"]);
  sheet.addRow(["0006724219", "1047885648", "08/07/2026", 1, "ACH", "263261790", 209.93, "Liberty Mutual"]);
  sheet.addRow(["0006724220", "1047885649", "08/08/2026", 1, "NON", "263261790", 10, "Liberty Mutual"]);
  sheet.addRow(["0006724221", "1047885650", "08/09/2026", 1, "MON", "263261790", 11, "Liberty Mutual"]);
  sheet.addRow(["126913", "", "08/06/2026", 1, "CHECK", "263261790", 475.67, "AdminSure"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

test("Jopari export keeps ACH/NON rows, excludes MON, and maps portal columns", async () => {
  const rows = await parseJopariExport(await exportWorkbook());
  assert.equal(rows.length, 2);
  assert.equal(rows[0].eftCheckNumber, "0006724219");
  assert.equal(rows[0].batchId, "1047885648");
  assert.equal(rows[0].payer, "Liberty Mutual");
});

test("Jopari comparison normalizes checks and falls back to batch ID in file names", () => {
  const base = { eftCheckNumber: "0006724219", batchId: "1047885648", payDate: "", claimsPaid: "", paymentMethod: "ACH", billingTin: "", paidAmount: "", payer: "" };
  assert.equal(existsInControlLog(base, { checkNumbers: new Set(["6724219"]), fileNames: [] }), true);
  assert.equal(existsInControlLog({ ...base, eftCheckNumber: "0000000000" }, { checkNumbers: new Set(), fileNames: ["CLIENT1047885648EOB"] }), true);
  assert.equal(existsInControlLog(base, { checkNumbers: new Set(), fileNames: [] }), false);
});

test("Jopari audit Excel includes portal fields and download outcome", async () => {
  const buffer = await createJopariAuditWorkbook([{ eftCheckNumber: "1", batchId: "2", payDate: "08/07/2026", claimsPaid: "1", paymentMethod: "ACH", billingTin: "3", paidAmount: "$4", payer: "Payer", comparison: "Unique", searchResult: "Found", downloadStatus: "Downloaded", filename: "1.pdf", message: "Success" }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.getWorksheet("Comparison Audit");
  assert.equal(sheet?.getCell("A1").value, "EFT/Check #");
  assert.equal(sheet?.getCell("K2").value, "Downloaded");
  assert.equal(sheet?.getCell("L2").value, "1.pdf");
});
