import assert from "node:assert/strict";
import test from "node:test";
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
        benefits: [],
      }],
    ]),
    errors: new Map([[3, "Portal response was unavailable."]]),
  });

  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]],
    { defval: "" },
  );

  assert.equal(rows[0]["Bot Entered First Name"], "Jane");
  assert.equal(rows[0]["Bot Entered Last Name"], "Doe");
  assert.equal(rows[0]["Bot Entered Member ID"], "ABC123");
  assert.equal(rows[0]["Bot Entered Date of Birth"], "01/02/1980");
  assert.equal(rows[0]["Bot Coverage Status"], "active");
  assert.equal(rows[0]["Bot Plan Name"], "PPO");
  assert.equal(rows[1]["Bot Error"], "Portal response was unavailable.");
});
