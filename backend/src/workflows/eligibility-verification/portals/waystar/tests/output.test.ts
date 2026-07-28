import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { buildWaystarOutputWorkbook } from "../output";

test("creates a Waystar output workbook with verified inputs, results, and row errors", async () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(inputWorkbook, XLSX.utils.aoa_to_sheet([
    ["First Name", "Last Name", "Member ID", "DOB"],
    ["Jane", "Doe", "ABC123", "01/02/1980"],
    ["John", "Smith", "XYZ789", "02/03/1975"],
  ]), "Eligibility");
  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const inputFile = new File([inputBuffer], "eligibility.xlsx");

  const output = await buildWaystarOutputWorkbook({
    inputFile,
    rows: new Map([
      [2, {
        originalIndex: 2,
        patientFirstName: "Jane",
        patientLastName: "Doe",
        memberId: "ABC123",
        dateOfBirth: "01/02/1980",
        raw: {},
      }],
      [3, {
        originalIndex: 3,
        patientFirstName: "John",
        patientLastName: "Smith",
        memberId: "XYZ789",
        dateOfBirth: "02/03/1975",
        raw: {},
      }],
    ]),
    results: new Map([
      [2, {
        rowIndex: 2,
        payerId: "blue-cross-blue-shield-texas",
        coverageStatus: "active",
        planName: "PPO",
        relationshipToSubscriber: "Spouse",
        benefits: [],
      }],
    ]),
    errors: new Map([[3, "Portal response was unavailable."]]),
  });

  const styledWorkbook = new ExcelJS.Workbook();
  await styledWorkbook.xlsx.load(output);
  const styledSheet = styledWorkbook.worksheets[0];
  const generatedHeader = styledSheet.getRow(1).getCell(5);
  assert.equal(generatedHeader.value, "Bot Entered Relationship to Subscriber");
  assert.equal(generatedHeader.font.bold, true);
  assert.equal(generatedHeader.font.color?.argb, "FFFFFFFF");
  assert.equal(generatedHeader.fill.type, "pattern");
  assert.equal(generatedHeader.fill.type === "pattern" ? generatedHeader.fill.fgColor?.argb : undefined, "FF1F4E78");

  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]],
    { defval: "" },
  );

  assert.equal("Bot Entered First Name" in rows[0], false);
  assert.equal("Bot Entered Last Name" in rows[0], false);
  assert.equal("Bot Entered Member ID" in rows[0], false);
  assert.equal("Bot Entered Date of Birth" in rows[0], false);
  assert.equal("Bot Address" in rows[0], false);
  assert.equal("Bot Sex" in rows[0], false);
  assert.equal(rows[0]["Bot Coverage Status"], "active");
  assert.equal("Bot Plan Status" in rows[0], false);
  const headerValues = styledSheet.getRow(1).values as unknown[];
  assert.equal(headerValues.indexOf("Bot Network"), headerValues.indexOf("Bot Coverage Status") + 1);
  assert.equal(rows[0]["Bot Plan Name"], "PPO");
  assert.equal(rows[0]["Bot Plan Type"], "-");
  assert.equal(rows[0]["Bot Entered Relationship to Subscriber"], "Spouse");
  assert.equal(rows[0]["Bot Error"], "-");
  assert.equal("Bot Patient Name" in rows[0], false);
  assert.equal("Bot Relationship to Subscriber" in rows[0], false);
  assert.equal("Bot Member ID" in rows[0], false);
  assert.equal("Bot Date of Birth" in rows[0], false);
  assert.equal(rows[1]["Bot Error"], "Portal response was unavailable.");
});
