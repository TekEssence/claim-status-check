import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { getWaystarPayer } from "../payer-registry";
import { buildWaystarOutputWorkbook } from "../output";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";

const row = { originalIndex: 2, dateOfService: "09/07/2026", raw: {} };
const payload = {
  overallStatus: "Active Coverage",
  exactResponseDates: { eligibilityBeginDate: "01/01/2026" },
  healthBenefitPlanCoverage: { eligibilityBeginDate: "03/01/2024", benefitBeginDate: "01/01/2026", eligibilityEndDate: "12/31/2026" },
  subscriberCoverageInformation: { planBeginDate: "02/15/2025", planDate: "08/01/2026 to 08/31/2026" },
};

test("MedRevenue Aetna writes subscriber Eligibility Begin Date to Eff Date and Plan Begin Date to Plan Date", async () => {
  const result = getWaystarPayer("aetna", "medrevenue").parseResult(payload, row);
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.planDate, "02/15/2025");
  assert.equal(result.terminationDate, "12/31/2026");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Payer: "Aetna", DOS: row.dateOfService }]), "Input");
  const inputFile = new File([new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))], "input.xlsx");
  const output = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: "medrevenue" });
  const parsed = XLSX.read(output, { type: "buffer" });
  const values = XLSX.utils.sheet_to_json<Record<string, unknown>>(parsed.Sheets.Output)[0];
  assert.equal(values["Eff Date"], "01/01/2026");
  assert.equal(values["Plan Date"], "02/15/2025");
});

test("Aetna missing exact dates stay blank and other payer date settings are unchanged", () => {
  const missing = { ...payload, exactResponseDates: {}, healthBenefitPlanCoverage: { eligibilityBeginDate: "03/01/2024", benefitBeginDate: "02/01/2024" }, subscriberCoverageInformation: { planDate: "08/01/2026" } };
  const result = getWaystarPayer("aetna", "medrevenue").parseResult(missing, row);
  assert.equal(result.effectiveDate, undefined);
  assert.equal(result.planDate, undefined);
  const minimax = getWaystarPayer("aetna", "minimax").parseResult(payload, row);
  assert.equal(minimax.effectiveDate, "03/01/2024");
  assert.equal(minimax.planDate, payload.subscriberCoverageInformation.planDate);
  for (const project of ["medrevenue", "minimax"] as const) {
    for (const payer of ["aetna", "umr", "scan", "medicare", "blue-shield", "bcbs-ppo", "united-healthcare-all-states"]) {
      assert.equal(Boolean(getWaystarPayerProjectConfig(getWaystarProjectConfig(project), payer).exactAetnaDates), project === "medrevenue" && payer === "aetna");
    }
  }
});
