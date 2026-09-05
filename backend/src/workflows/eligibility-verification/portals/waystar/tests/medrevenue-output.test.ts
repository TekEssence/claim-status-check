import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildWaystarOutputWorkbook } from "../output";
import type { EligibilityInputRow, EligibilityResult } from "../../../types";

function inputFile(): File {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ["First Name", "Last Name", "Member ID", "DOB", "DOS"],
    ["Jane", "Doe", "ABC123", "01/02/1980", "08/14/2026"],
  ]), "Eligibility");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([buffer], "eligibility.xlsx");
}

const row: EligibilityInputRow = {
  originalIndex: 2,
  memberId: "ABC123",
  patientFirstName: "Jane",
  patientLastName: "Doe",
  dateOfBirth: "01/02/1980",
  dateOfService: "08/14/2026",
  raw: {},
};

const result: EligibilityResult = {
  rowIndex: 2,
  payerId: "medicare",
  coverageStatus: "active",
  effectiveDate: "01/01/2026",
  terminationDate: "12/31/2026",
  relationshipToSubscriber: "Self",
  planType: "Medicare",
  insuranceType: "Medicare",
  planDate: "08/14/2026 to 08/14/2026",
  benefits: [],
  metadata: { medRevenuePrescriptionDrugServiceType: "Pharmacy" },
};

test("MedRevenue uses the unchanged Minimax output format plus Plan Date", async () => {
  const common = {
    rows: new Map([[2, row]]),
    results: new Map([[2, result]]),
    errors: new Map<number, string>(),
  };
  const minimaxOutput = await buildWaystarOutputWorkbook({
    ...common, inputFile: inputFile(), projectId: "minimax",
  });
  const medRevenueOutput = await buildWaystarOutputWorkbook({
    ...common, inputFile: inputFile(), projectId: "medrevenue",
  });

  const minimaxWorkbook = XLSX.read(minimaxOutput, { type: "buffer" });
  const medRevenueWorkbook = XLSX.read(medRevenueOutput, { type: "buffer" });
  assert.deepEqual(medRevenueWorkbook.SheetNames, minimaxWorkbook.SheetNames);

  const minimaxRows = XLSX.utils.sheet_to_json<Record<string, string>>(
    minimaxWorkbook.Sheets[minimaxWorkbook.SheetNames[0]], { defval: "" },
  );
  const medRevenueRows = XLSX.utils.sheet_to_json<Record<string, string>>(
    medRevenueWorkbook.Sheets[medRevenueWorkbook.SheetNames[0]], { defval: "" },
  );
  const minimaxHeaders = Object.keys(minimaxRows[0]);
  const medRevenueHeaders = Object.keys(medRevenueRows[0]);

  assert.deepEqual(medRevenueHeaders.slice(0, -2), minimaxHeaders);
  assert.deepEqual(medRevenueHeaders.slice(-2), ["Plan Date", "Service Type"]);
  for (const header of minimaxHeaders) {
    assert.equal(medRevenueRows[0][header], minimaxRows[0][header]);
  }
  assert.equal(medRevenueRows[0]["Plan Date"], "08/14/2026 to 08/14/2026");
  assert.equal(medRevenueRows[0]["Service Type"], "Pharmacy");
});

test("MedRevenue keeps the full Eligibility Date range in Eff Date only", async () => {
  const output = await buildWaystarOutputWorkbook({
    inputFile: inputFile(),
    rows: new Map([[2, row]]),
    results: new Map([[2, {
      ...result,
      effectiveDate: "08/14/2026 to 08/14/2026",
      terminationDate: undefined,
    }]]),
    errors: new Map(),
    projectId: "medrevenue",
  });
  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]], { defval: "" },
  );
  assert.equal(rows[0]["Eff Date"], "08/14/2026 to 08/14/2026");
  assert.equal(rows[0]["End Date"], "-");
});
