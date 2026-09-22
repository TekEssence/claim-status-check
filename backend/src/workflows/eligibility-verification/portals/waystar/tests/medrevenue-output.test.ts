import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildWaystarOutputWorkbook } from "../output";
import { applyMedRevenueIpaResultMapping } from "../scraper";
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

test("MedRevenue exports the associated IPA only for the portal HMO plan type", async () => {
  for (const [planType, ipa, expected] of [
    ["Health Maintenance Organization - HMO", " Example Medical Group ", "Example Medical Group"],
    ["Health Maintenance Organization (HMO)", "Example IPA", "Example IPA"],
    ["HMO", undefined, "-"],
    ["Preferred Provider Organization - PPO", "Example IPA", "-"],
    [undefined, "Example IPA", "-"],
  ]) {
    // A payer may replace the displayed plan type with a plan name.
    const mapped = applyMedRevenueIpaResultMapping({ ...result, planType: "Custom plan name", ipa: "Old IPA" }, {
      healthBenefitPlanCoverage: { planType }, general: { ipa },
    });
    const output = await buildWaystarOutputWorkbook({
      inputFile: inputFile(), rows: new Map([[2, row]]), results: new Map([[2, mapped]]),
      errors: new Map(), projectId: "medrevenue",
    });
    const workbook = XLSX.read(output, { type: "buffer" });
    const values = XLSX.utils.sheet_to_json<Record<string, string>>(workbook.Sheets[workbook.SheetNames[0]])[0];
    assert.equal(values.IPA, expected);
  }
});

test("MedRevenue extends the Minimax output with Plan Date, Service Type and IPA", async () => {
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
  const minimaxHeaders = Object.keys(minimaxRows[0]).filter((header) => header !== "error");
  const medRevenueHeaders = Object.keys(medRevenueRows[0]);

  assert.deepEqual(medRevenueHeaders.slice(0, minimaxHeaders.length), minimaxHeaders);
  assert.deepEqual(medRevenueHeaders.slice(minimaxHeaders.length), ["Address", "Plan Date", "Service Type", "IPA", "Date of Death"]);
  assert.equal(medRevenueRows[0]["IPA"], "-");
  for (const header of minimaxHeaders) {
    assert.equal(medRevenueRows[0][header], minimaxRows[0][header]);
  }
  assert.equal(medRevenueRows[0]["Address"], "-");
  assert.equal(medRevenueRows[0]["Plan Date"], "08/14/2026 to 08/14/2026");
  assert.equal(medRevenueRows[0]["Service Type"], "Pharmacy");
});

test("MedRevenue Waystar exports subscriber address from payer response", async () => {
  const output = await buildWaystarOutputWorkbook({
    inputFile: inputFile(),
    rows: new Map([[2, row]]),
    results: new Map([[2, {
      ...result,
      payerId: "umr",
      address: "Patient fallback address",
      metadata: {
        subscriberInformation: {
          address: "1634 REDWOOD WAY UPLAND, CA 917841787",
        },
      },
    }]]),
    errors: new Map(),
    projectId: "medrevenue",
  });
  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]], { defval: "" },
  );

  assert.equal(rows[0].Address, "1634 REDWOOD WAY UPLAND, CA 917841787");
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

test("MedRevenue Medicare exports exact Part B dates and status", async () => {
  const output = await buildWaystarOutputWorkbook({
    inputFile: inputFile(),
    rows: new Map([[2, row]]),
    results: new Map([[2, {
      ...result,
      effectiveDate: "09/01/2014",
      terminationDate: "12/31/2026",
      metadata: {
        medRevenueMedicarePartBStatus: "ACTIVE COVERAGE",
        medRevenueMedicareDateOfDeathStatus: "Dead",
      },
    }]]),
    errors: new Map(),
    projectId: "medrevenue",
  });
  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]], { defval: "" },
  );

  assert.equal(rows[0]["Coverage Status"], "ACTIVE COVERAGE");
  assert.equal(rows[0]["Eff Date"], "09/01/2014");
  assert.equal(rows[0]["End Date"], "12/31/2026");
  assert.equal(rows[0]["Date of Death"], "Dead");
});

test("MedRevenue suppresses partial extracted values when the row status is error", async () => {
  const output = await buildWaystarOutputWorkbook({
    inputFile: inputFile(),
    rows: new Map([[2, row]]),
    results: new Map([[2, {
      ...result,
      coverageStatus: "error",
      effectiveDate: "08/14/2026 to 08/14/2026",
      planDate: "05/01/2019",
    }]]),
    errors: new Map([[2, "Subscriber Not Found"]]),
    projectId: "medrevenue",
  });
  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]], { defval: "" },
  );

  assert.equal(rows[0]["Coverage Status"], "error");
  assert.equal(rows[0]["Eff Date"], "-");
  assert.equal(rows[0]["Plan Date"], "-");
  assert.equal(rows[0]["Other Ins"], "-");
  assert.equal(rows[0]["Service Type"], "-");
});

test("MedRevenue Medicare shows subscriber not found instead of generic error", async () => {
  const output = await buildWaystarOutputWorkbook({
    inputFile: inputFile(),
    rows: new Map([[2, row]]),
    results: new Map([[2, {
      ...result,
      coverageStatus: "error",
      planStatus: "Subscriber Not Found",
      effectiveDate: "",
      terminationDate: "",
    }]]),
    errors: new Map(),
    projectId: "medrevenue",
  });
  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]], { defval: "" },
  );

  assert.equal(rows[0]["Coverage Status"], "Subscriber Not Found");
  assert.equal(rows[0]["Eff Date"], "-");
});

test("MedRevenue Blue Cross adds three secondary columns and reuses Service Type", async () => {
  const output = await buildWaystarOutputWorkbook({
    inputFile: inputFile(),
    rows: new Map([[2, row]]),
    results: new Map([[2, {
      ...result,
      payerId: "bcbs-ppo",
      metadata: {
        medRevenueSecondaryCoverageDescription: "SECONDARY BLUE ON BLUE INTRA",
        medRevenueSecondaryCobDate: "04/02/2019",
        medRevenueSecondaryGroupOrPolicyNumber: "KZU27119127E",
        medRevenueSecondaryServiceType: "Health Benefit Plan Coverage",
        medRevenueOutputServiceType: "Health Benefit Plan Coverage",
      },
    }]]),
    errors: new Map(),
    projectId: "medrevenue",
  });
  const workbook = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(
    workbook.Sheets[workbook.SheetNames[0]], { defval: "" },
  );

  assert.equal(rows[0]["Secondary Coverage Description"], "SECONDARY BLUE ON BLUE INTRA");
  assert.equal(rows[0]["Secondary COB Date"], "04/02/2019");
  assert.equal(rows[0]["Secondary Group or Policy Number"], "KZU27119127E");
  assert.equal(rows[0]["Service Type"], "Health Benefit Plan Coverage");
  assert.equal(Object.hasOwn(rows[0], "Secondary Service Type"), false);
});
