import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { applyUhcRowUpdateToWorksheet, parseUhcClaimRows } from "../workbook";

async function buildWorksheet(headers: string[], rows: Record<string, unknown>[]) {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  headers.forEach((header, index) => {
    worksheet.getRow(1).getCell(index + 1).value = header;
  });
  worksheet.getRow(1).commit();

  rows.forEach((row, rowIndex) => {
    const worksheetRow = worksheet.getRow(rowIndex + 2);
    headers.forEach((header, colIndex) => {
      worksheetRow.getCell(colIndex + 1).value = row[header] as ExcelJS.CellValue;
    });
    worksheetRow.commit();
  });

  return worksheet;
}

test("UHC MedRevenu rows do not require Patient DOB and preserve CPT/service code", async () => {
  const worksheet = await buildWorksheet(
    ["Subscriber ID", "Patient Name", "Service Date", "Service Code"],
    [
      {
        "Subscriber ID": "123456789",
        "Patient Name": "DOE, JANE",
        "Service Date": "04/16/2026",
        "Service Code": "99213",
      },
    ],
  );

  const rows = parseUhcClaimRows(worksheet, { requirePatientDob: false });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].subscriberNo, "123456789");
  assert.equal(rows[0].patientDOB, "");
  assert.equal(rows[0].patientName, "DOE, JANE");
  assert.equal(rows[0].serviceDate, "04/16/2026");
  assert.equal(rows[0]["Service Code"], "99213");
});

test("UHC Minimax rows can load without Patient DOB", async () => {
  const worksheet = await buildWorksheet(
    ["Subscriber ID", "Patient Name", "Service Date"],
    [
      {
        "Subscriber ID": "123456789",
        "Patient Name": "DOE, JANE",
        "Service Date": "04/16/2026",
      },
    ],
  );

  const rows = parseUhcClaimRows(worksheet, { requirePatientDob: true });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].subscriberNo, "123456789");
  assert.equal(rows[0].patientDOB, "");
  assert.equal(rows[0].serviceDate, "04/16/2026");
});

test("UHC parser accepts Excel serial service dates", async () => {
  const worksheet = await buildWorksheet(
    ["Member ID", "DOB", "DOS"],
    [
      {
        "Member ID": "123456789",
        DOB: 18050,
        DOS: 46128,
      },
    ],
  );

  const rows = parseUhcClaimRows(worksheet, { requirePatientDob: true });

  assert.equal(rows[0].patientDOB, "06/01/1949");
  assert.equal(rows[0].serviceDate, "04/16/2026");
});

test("UHC writer stores accounting credit amounts as negative Excel numbers", async () => {
  const worksheet = await buildWorksheet(
    ["Subscriber ID", "Patient Name", "Service Date"],
    [
      {
        "Subscriber ID": "123456789",
        "Patient Name": "DOE, JANE",
        "Service Date": "04/16/2026",
      },
    ],
  );

  applyUhcRowUpdateToWorksheet(worksheet, {
    rowIndex: 2,
    update: {
      BotPaidAmount: "$(51.00)",
      BotBilledAmount: "$100.00",
    },
  });

  const headerValues = worksheet.getRow(1).values as ExcelJS.CellValue[];
  const paidCol = headerValues.findIndex((value) => value === "BotPaidAmount");
  const billedCol = headerValues.findIndex((value) => value === "BotBilledAmount");

  assert.equal(worksheet.getRow(2).getCell(paidCol).value, -51);
  assert.equal(worksheet.getRow(2).getCell(billedCol).value, 100);
  assert.equal(worksheet.getRow(2).getCell(paidCol).numFmt, "$#,##0.00;-$#,##0.00");
});
