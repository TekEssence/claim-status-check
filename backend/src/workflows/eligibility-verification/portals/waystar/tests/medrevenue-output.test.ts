import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildWaystarOutputWorkbook } from "../output";
import type { EligibilityInputRow, EligibilityResult } from "../../../types";

function inputRow(index: number, memberId: string): EligibilityInputRow {
  return {
    originalIndex: index,
    memberId,
    patientFirstName: "Test",
    patientLastName: `Patient ${index}`,
    dateOfBirth: "01/01/1950",
    dateOfService: "08/14/2026",
    raw: { "Member ID": memberId, DOS: "08/14/2026" },
  };
}

function result(rowIndex: number, planStatus: string, coverageStatus: EligibilityResult["coverageStatus"]): EligibilityResult {
  return {
    rowIndex,
    payerId: "medicare",
    coverageStatus,
    planStatus,
    benefits: [],
    metadata: {
      fullPayerResponse: {
        subscriberInformation: { fields: { "Member ID": `member-${rowIndex}` } },
        otherCoverageInformation: [{ title: "OTHER COVERAGE INFORMATION", rows: [{ label: "Payer", value: "Example" }] }],
        generalInformation: [{
          title: "QUALIFIED MEDICARE BENEFICIARY",
          rows: [
            { label: "Coverage Description", value: "CA QMB PLAN" },
            { label: "Coverage Description", value: "MEDICARE PART A" },
            { label: "Coverage Description", value: "MEDICARE PART B" },
            { label: "Coverage Description", value: "MEDICARE PART B" },
            { label: "Service Type", value: "Health Benefit Plan Coverage" },
            { label: "Service Type", value: "Health Benefit Plan Coverage" },
            { label: "Plan Date", value: "01/01/2026 to 04/30/2026" },
            { label: "Benefit Date", value: "01/01/2026 to 12/31/2026" },
            { label: "COB Date", value: "01/01/2025 to 04/30/2026" },
            { label: "Deductible", value: "$0.00" },
          ],
        }],
      },
    },
  };
}

test("MedRevenue output retains found, partial, and subscriber-not-found rows in four sheets", async () => {
  const rows = new Map([[2, inputRow(2, "A")], [3, inputRow(3, "B")], [4, inputRow(4, "C")]]);
  const results = new Map([
    [2, result(2, "Active Coverage", "active")],
    [3, result(3, "Active Coverage", "active")],
    [4, result(4, "Subscriber Not Found", "error")],
  ]);
  const buffer = await buildWaystarOutputWorkbook({
    inputFile: new File([new Uint8Array([1])], "unused.xlsx"),
    rows,
    results,
    errors: new Map(),
    projectId: "medrevenue",
  });
  const workbook = XLSX.read(buffer, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["Input", "Output", "Audit Log", "Error Log"]);
  const outputRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets.Output, { header: 1 });
  const auditRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets["Audit Log"], { header: 1 });
  const errorRows = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets["Error Log"], { header: 1 });
  assert.equal(outputRows.length, 4);
  assert.equal(auditRows.length, 4);
  assert.equal(errorRows.length, 2);
  assert.equal(outputRows[3]?.[3], "Subscriber Not Found");
  const headers = outputRows[0] as string[];
  for (const removedHeader of [
    "Plan Name", "Eff Date", "End Date", "Other Ins", "Other Ins Eff Date",
    "Relationship to Subscriber", "Plan Type", "Bot Insurance Type",
    "Group Number", "Primary Care Provider", "Network", "Coinsurance", "Copay", "Deductible",
    "Qualified Medicare Beneficiary Plan Date", "Qualified Medicare Beneficiary Benefit Date",
    "Qualified Medicare Beneficiary COB Date",
    "Raw Result", "Processed", "Full Subscriber Information",
    "Full Subscriber Coverage Information", "Full Other Coverage Information", "Full General Information",
  ]) {
    assert.equal(headers.includes(removedHeader), false);
  }
  const coverageHeader = "Qualified Medicare Beneficiary Coverage Description";
  const serviceTypeHeader = "Qualified Medicare Beneficiary Service Type";
  assert.equal(headers.filter((header) => header === coverageHeader).length, 1);
  assert.equal(headers.filter((header) => header === serviceTypeHeader).length, 1);
  assert.equal(
    outputRows[1]?.[headers.indexOf(coverageHeader)],
    "CA QMB PLAN; MEDICARE PART A; MEDICARE PART B",
  );
  assert.equal(outputRows[1]?.[headers.indexOf(serviceTypeHeader)], "Health Benefit Plan Coverage");
});
