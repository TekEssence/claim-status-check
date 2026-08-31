import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { buildWaystarBulkPayments, buildWaystarControlLog, buildWaystarSearchResults, buildWaystarZeroPayments } from "./output-builder";
import type { WaystarControlLogRow, WaystarSearchResult } from "./types";

const result: WaystarSearchResult = {
  phase: "Cash Log", clientName: "Clinic A", inputCheckNumber: "00123", inputBatchTotalAmount: "$10.00", searchResult: "FOUND",
  portalPaymentNumber: "00123", portalPaymentAmount: "$10.00", portalPaymentDate: "08/27/2026", portalPayer: "Payer A",
  portalType: "ACH", amountMatch: "YES", pdfStatus: "DOWNLOAD_SUCCESS", pdfFileName: "00123.pdf",
  archiveStatus: "ARCHIVED_SUCCESS", finalResult: "DOWNLOAD_SUCCESS", error: "",
};

test("Waystar search results use the required column order", async () => {
  const workbook = new ExcelJS.Workbook();
  const output = await buildWaystarSearchResults([result]);
  await workbook.xlsx.load(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values, [undefined, "Phase", "Client Name", "Input Check Number", "Input Batch Total Amount", "Search Result",
    "Portal Payment #", "Portal Payment Amount", "Portal Payment Date", "Portal Payer", "Portal Type", "Amount Match", "PDF Status",
    "PDF File Name", "Archive Status", "Final Result", "Error"]);
  assert.equal(sheet.getRow(2).getCell(9).value, "Payer A");
});

test("Waystar control output preserves rows and updates only successful payments", async () => {
  const headers = ["Client Name", "File Name", "Source", "Mode of payment", "Check number", "Posting Date", "Batch Total Amount", "Keep Me"];
  const row: WaystarControlLogRow = { rowNumber: 2, clientName: "Clinic A", checkNumber: "00123", batchTotalAmount: "$10.00",
    entryStatus: "In Progress", source: "Waystar", values: Object.fromEntries(headers.map((header) => [header, header === "Keep Me" ? "original" : "old"])) };
  const workbook = new ExcelJS.Workbook();
  const output = await buildWaystarControlLog(headers, [row], new Map([[2, result]]));
  await workbook.xlsx.load(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
  const values = workbook.worksheets[0].getRow(2).values;
  assert.deepEqual(values, [undefined, "Clinic A", "00123.pdf", "Web", "ACH", "00123", "08/27/2026", "$10.00", "original"]);
});

test("Waystar zero-payment output uses the requested columns", async () => {
  const workbook = new ExcelJS.Workbook();
  const output = await buildWaystarZeroPayments([{
    source: "Waystar",
    modeOfPayment: "NON",
    checkNumber: "NO-PAY-1",
    depositDatePaymentPostingDate: "08/28/2026",
    batchTotalAmount: "$0.00",
    pdfFileName: "NO-PAY-1_08_28_2026.pdf",
    downloadStatus: "DOWNLOAD_SUCCESS",
    archiveStatus: "ARCHIVED_SUCCESS",
    error: "",
  }]);
  await workbook.xlsx.load(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  assert.deepEqual(sheet.getRow(1).values, [undefined, "Source", "Mode of Payment", "Check Number", "Deposit Date / Payment Posting Date", "Batch Total Amount",
    "PDF File Name", "Download Status", "Archive Status", "Error"]);
  assert.deepEqual(sheet.getRow(2).values, [undefined, "Waystar", "NON", "NO-PAY-1", "08/28/2026", "$0.00",
    "NO-PAY-1_08_28_2026.pdf", "DOWNLOAD_SUCCESS", "ARCHIVED_SUCCESS", ""]);
});

test("Waystar bulk output creates a phase-specific workbook", async () => {
  const workbook = new ExcelJS.Workbook();
  const output = await buildWaystarBulkPayments("ACH", [{
    clientName: "TAJ",
    paymentType: "ACH",
    paymentNumber: "83561562",
    paymentAmount: "$6761.32",
    paymentDate: "08/26/2026",
    payer: "Medicare B California Northern",
    pdfFileName: "83561562_08_26_2026.pdf",
    downloadStatus: "DOWNLOAD_SUCCESS",
    archiveStatus: "ARCHIVED_SUCCESS",
    error: "",
  }]);
  await workbook.xlsx.load(output.buffer.slice(output.byteOffset, output.byteOffset + output.byteLength) as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  assert.equal(sheet.name, "ACH Payments");
  assert.deepEqual(sheet.getRow(1).values, [undefined, "Client Name", "Payment Type", "Payment Number", "Payment Amount", "Payment Date", "Payer",
    "PDF File Name", "Download Status", "Archive Status", "Error"]);
  assert.equal(sheet.getRow(2).getCell(3).value, "83561562");
});
