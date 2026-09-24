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
        payerId: "bcbs-ppo",
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
  assert.equal(generatedHeader.value, "Coverage Status");
  assert.equal(generatedHeader.font.bold, true);
  const headerValues = styledSheet.getRow(1).values as unknown[];
  assert.deepEqual(headerValues.slice(5), [
    "Coverage Status", "Eff Date", "End Date", "Other Ins",
    "Other Ins Eff Date", "Relationship to Subscriber", "Plan Type", "Bot Insurance Type", "error",
  ]);

  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  assert.equal(rows[0]["Coverage Status"], "active");
  assert.equal(rows[0]["Relationship to Subscriber"], "Spouse");
  assert.equal(rows[1]["Relationship to Subscriber"], "Self");
  assert.equal(rows[0].error, "-");
  assert.equal(rows[1].error, "Portal response was unavailable.");
  assert.equal("Bot Network" in rows[0], false);
  assert.equal("Bot Error" in rows[0], false);});
test("writes UMR Plan Network Name in the existing Plan Type column", async () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(inputWorkbook, XLSX.utils.aoa_to_sheet([
    ["Member ID"],
    ["ABC123"],
  ]), "Eligibility");
  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const output = await buildWaystarOutputWorkbook({
    inputFile: new File([inputBuffer], "umr-eligibility.xlsx"),
    rows: new Map([[2, { originalIndex: 2, memberId: "ABC123", raw: {} }]]),
    results: new Map([[2, {
      rowIndex: 2,
      payerId: "umr",
      coverageStatus: "active",
      effectiveDate: "01/01/2025",
      planType: "UNITEDHEALTHCARE CHOICE PLUS",
      benefits: [],
    }]]),
    errors: new Map(),
  });

  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  assert.equal(rows[0]["Eff Date"], "01/01/2025");
  assert.equal(rows[0]["Plan Type"], "UNITEDHEALTHCARE CHOICE PLUS");
  assert.equal("Plan Name" in rows[0], false);
  assert.equal("Bot Plan Name" in rows[0], false);
});

test("adds PPO and HMO plan markers to Bot Insurance Type from Plan Type", async () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(inputWorkbook, XLSX.utils.aoa_to_sheet([
    ["Member ID"],
    ["PPO123"],
    ["HMO123"],
    ["DUP123"],
  ]), "Eligibility");
  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const output = await buildWaystarOutputWorkbook({
    inputFile: new File([inputBuffer], "insurance-type.xlsx"),
    rows: new Map([
      [2, { originalIndex: 2, memberId: "PPO123", raw: {} }],
      [3, { originalIndex: 3, memberId: "HMO123", raw: {} }],
      [4, { originalIndex: 4, memberId: "DUP123", raw: {} }],
    ]),
    results: new Map([
      [2, {
        rowIndex: 2,
        payerId: "united-healthcare-all-states",
        coverageStatus: "active",
        planType: "LPPO-UNITEDHEALTHCARE GROUP MEDICARE ADVANTAGE",
        insuranceType: "Managed Medicare",
        benefits: [],
      }],
      [3, {
        rowIndex: 3,
        payerId: "united-healthcare-all-states",
        coverageStatus: "active",
        planType: "HMOPOS-AARP MEDICARE ADVANTAGE",
        insuranceType: "Managed Medicare",
        benefits: [],
      }],
      [4, {
        rowIndex: 4,
        payerId: "united-healthcare-all-states",
        coverageStatus: "active",
        planType: "AARP Medicare Advantage (PPO)",
        insuranceType: "Managed Medicare (PPO)",
        benefits: [],
      }],
    ]),
    errors: new Map(),
  });

  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  assert.equal(rows[0]["Bot Insurance Type"], "Managed Medicare (PPO)");
  assert.equal(rows[1]["Bot Insurance Type"], "Managed Medicare (HMO)");
  assert.equal(rows[2]["Bot Insurance Type"], "Managed Medicare (PPO)");
});

test("marks unresolved rows as error instead of blank coverage status", async () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(inputWorkbook, XLSX.utils.aoa_to_sheet([
    ["Member ID"],
    ["UNRESOLVED"],
  ]), "Eligibility");
  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const output = await buildWaystarOutputWorkbook({
    inputFile: new File([inputBuffer], "unresolved.xlsx"),
    rows: new Map([[2, { originalIndex: 2, memberId: "UNRESOLVED", raw: {} }]]),
    results: new Map(),
    errors: new Map(),
  });

  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  assert.equal(rows[0]["Coverage Status"], "error");
  assert.equal(rows[0].error, "Eligibility row was not processed before output was created.");
});

test("normalizes unknown coverage and technical timeout errors for Excel output", async () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(inputWorkbook, XLSX.utils.aoa_to_sheet([
    ["Member ID"],
    ["UNKNOWN"],
    ["TIMEOUT"],
  ]), "Eligibility");
  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const output = await buildWaystarOutputWorkbook({
    inputFile: new File([inputBuffer], "strict-status.xlsx"),
    rows: new Map([
      [2, { originalIndex: 2, memberId: "UNKNOWN", raw: {} }],
      [3, { originalIndex: 3, memberId: "TIMEOUT", raw: {} }],
    ]),
    results: new Map([[2, {
      rowIndex: 2,
      payerId: "aetna",
      coverageStatus: "unknown",
      planStatus: "Eligibility response did not include active or inactive coverage.",
      benefits: [],
    }]]),
    errors: new Map([[3, "locator.pressSequentially: Timeout 30000ms exceeded.\nCall log:\n - waiting for locator('#FName:visible').first()"]]),
  });

  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "" });
  assert.equal(rows[0]["Coverage Status"], "error");
  assert.equal(rows[0].error, "Eligibility response did not include active or inactive coverage.");
  assert.equal(rows[1]["Coverage Status"], "error");
  assert.equal(rows[1].error, "Waystar First Name field did not become ready before timeout. The row was not submitted.");
});

test("replaces a previous Waystar output block instead of keeping stale coverage statuses", async () => {
  const inputWorkbook = XLSX.utils.book_new();
  const oldHeaders = [
    "Coverage Status", "Eff Date", "End Date", "Other Ins",
    "Other Ins Eff Date", "Relationship to Subscriber", "Plan Type", "Bot Insurance Type", "error",
  ];
  XLSX.utils.book_append_sheet(inputWorkbook, XLSX.utils.aoa_to_sheet([
    ["Member ID", ...oldHeaders],
    ["ABC123", "-", "-", "-", "-", "-", "Self", "-", "-", "old raw locator timeout"],
    ["XYZ789", "unknown", "-", "-", "-", "-", "Self", "-", "-", "old unknown"],
  ]), "Eligibility");
  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;

  const output = await buildWaystarOutputWorkbook({
    inputFile: new File([inputBuffer], "rerun-output.xlsx"),
    rows: new Map([
      [2, { originalIndex: 2, memberId: "ABC123", raw: {} }],
      [3, { originalIndex: 3, memberId: "XYZ789", raw: {} }],
    ]),
    results: new Map([[2, {
      rowIndex: 2,
      payerId: "aetna",
      coverageStatus: "active",
      effectiveDate: "01/01/2026",
      benefits: [],
    }]]),
    errors: new Map([[3, "Subscriber Not Found"]]),
  });

  const workbook = XLSX.read(output, { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(sheet, { defval: "" });
  const headerRow = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0];
  assert.equal(headerRow.filter((header) => header === "Coverage Status").length, 1);
  assert.equal(rows[0]["Coverage Status"], "active");
  assert.equal(rows[1]["Coverage Status"], "error");
  assert.equal(rows[1].error, "Subscriber Not Found");
});

test("includes an unresolved payer error in the Minimax error column", async () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(inputWorkbook, XLSX.utils.aoa_to_sheet([
    ["Member ID"], ["TEST-MEMBER"],
  ]), "Eligibility");
  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" });
  const output = await buildWaystarOutputWorkbook({
    inputFile: new File([new Uint8Array(inputBuffer)], "input.xlsx"),
    projectId: "minimax",
    rows: new Map(),
    results: new Map([[2, { rowIndex: 2, payerId: "aetna", coverageStatus: "error",
      planStatus: "Failed at payer: subscriber not found", benefits: [] }]]),
    errors: new Map(),
  });
  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]]);
  assert.equal(rows[0].error, "Failed at payer: subscriber not found");
});
