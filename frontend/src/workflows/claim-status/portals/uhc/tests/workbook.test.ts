import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { applyUhcRowUpdateToWorksheet, parseUhcClaimRows, postProcessUhcWorksheet } from "../workbook";

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
    ["Group", "Subscriber ID", "Patient Name", "Service Date", "Service Code"],
    [
      {
        Group: "BZA",
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
    ["Group", "Subscriber ID", "Patient Name", "Service Date"],
    [
      {
        Group: "BZA",
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
    ["Group", "Member ID", "DOB", "DOS"],
    [
      {
        Group: "BZA",
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

test("UHC parser prefers exact DOS column and accepts single-digit month/day", async () => {
  const worksheet = await buildWorksheet(
    ["Group", "Member ID", "Date of Service", "DOS"],
    [
      {
        Group: "BZA",
        "Member ID": "123456789",
        "Date of Service": "01/01/1900",
        DOS: "3/4/2026",
      },
    ],
  );

  const rows = parseUhcClaimRows(worksheet, { requirePatientDob: false });

  assert.equal(rows[0].serviceDate, "3/4/2026");
});

test("UHC writer stores accounting credit amounts as negative Excel numbers", async () => {
  const worksheet = await buildWorksheet(
    ["Group", "Subscriber ID", "Patient Name", "Service Date"],
    [
      {
        Group: "BZA",
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

test("UHC partial workbook keeps completed rows and leaves remaining rows open", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Group", "Subscriber ID", "DOS"]);
  worksheet.addRow(["BZA", "member-1", "04/16/2026"]);
  worksheet.addRow(["BZA", "member-2", "04/17/2026"]);
  applyUhcRowUpdateToWorksheet(worksheet, {
    index: 0, rowIndex: 2,
    update: { BotClaimStatus: "Paid", BotPaidAmount: "$25.00" },
  });
  postProcessUhcWorksheet(worksheet);

  const saved = new ExcelJS.Workbook();
  await saved.xlsx.load(await workbook.xlsx.writeBuffer());
  const result = saved.worksheets[0];
  const headers = result.getRow(1).values as ExcelJS.CellValue[];
  const statusCol = headers.findIndex((value) => value === "BotClaimStatus");
  const paidCol = headers.findIndex((value) => value === "BotPaidAmount");
  assert.equal(result.getRow(2).getCell(statusCol).value, "Paid");
  assert.equal(result.getRow(2).getCell(paidCol).value, 25);
  assert.equal(result.getRow(3).getCell(statusCol).value, null);
});

test("UHC partial workbook keeps a completed duplicate when an earlier duplicate is pending", async () => {
  const worksheet = await buildWorksheet(
    ["Group", "Subscriber ID", "DOS"],
    [
      { Group: "BZA", "Subscriber ID": "member-1", DOS: "04/16/2026" },
      { Group: "BZA", "Subscriber ID": "member-1", DOS: "04/16/2026" },
    ],
  );
  applyUhcRowUpdateToWorksheet(worksheet, {
    rowIndex: 3,
    update: { BotClaimStatus: "Paid", BotPaidAmount: "$25.00" },
  });
  postProcessUhcWorksheet(worksheet);

  const headers = worksheet.getRow(1).values as ExcelJS.CellValue[];
  const statusCol = headers.findIndex((value) => value === "BotClaimStatus");
  assert.equal(worksheet.getRow(2).getCell(statusCol).value, "Paid");
  assert.equal(worksheet.getRow(3).getCell(statusCol).value, "Paid");
});
