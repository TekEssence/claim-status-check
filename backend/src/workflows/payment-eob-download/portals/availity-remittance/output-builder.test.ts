import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { createPaymentEobResultWorkbookBuffer, createPaymentTrackerWorkbookBuffer } from "./output-builder";

test("creates the exact Payment Tracker columns and numeric currency amount", async () => {
  const buffer = await createPaymentTrackerWorkbookBuffer([{
    source: "Availity",
    eraDownloadedDate: "08/27/2026",
    payerName: "ARKANSAS TOTAL CARE",
    payeeName: "BENTONVILLE PEDIATRICS",
    checkNumber: "0900562787",
    checkDate: "07/15/2026",
    checkAmount: "$1,835.54",
  }]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const worksheet = workbook.getWorksheet("Payment Tracker");
  assert.ok(worksheet);
  assert.deepEqual(worksheet.getRow(1).values, [undefined, "Source", "ERA Downloaded Date", "Payer Name", "Payee Name", "Check/EFT #", "Check / EFT Date", "Check Amount"]);
  assert.equal(worksheet.getCell("E2").text, "0900562787");
  assert.equal(worksheet.getCell("G2").value, 1835.54);
  assert.equal(worksheet.getCell("G2").numFmt, "$#,##0.00");
});

test("keeps comparison_result.xlsx columns unchanged", async () => {
  const buffer = await createPaymentEobResultWorkbookBuffer([]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as never);
  const worksheet = workbook.getWorksheet("Comparison Result");
  assert.ok(worksheet);
  assert.deepEqual(worksheet.getRow(1).values, [undefined, "Check/EFT Number", "Check Date", "Comparison", "Search Result", "PDF Status", "Filename", "Message"]);
});
