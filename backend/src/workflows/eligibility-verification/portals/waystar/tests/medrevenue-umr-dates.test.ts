import assert from "node:assert/strict";
import test from "node:test";
import { getWaystarPayer } from "../payer-registry";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";
import { buildWaystarOutputWorkbook } from "../output";
import * as XLSX from "xlsx";

const row = { originalIndex: 2, dateOfService: "09/07/2026", raw: {} };
const payload = {
  overallStatus: "Active Coverage",
  exactResponseDates: { benefitBeginDate: "01/01/2025" },
  healthBenefitPlanCoverage: { eligibilityBeginDate: "01/01/2025", eligibilityEndDate: "12/31/2026", benefitBeginDate: "03/01/2025" },
  subscriberCoverageInformation: { planBeginDate: "07/01/2024", planDate: "08/01/2026 to 08/31/2026", planNetworkName: "PPO" },
};

test("MedRevenue UMR uses Other Coverage Benefit Begin Date and Plan Begin Date in Excel", async () => {
  const result = getWaystarPayer("umr", "medrevenue").parseResult(payload, row);
  assert.equal(result.effectiveDate, "01/01/2025");
  assert.equal(result.planDate, "07/01/2024");
  assert.equal(result.terminationDate, "12/31/2026");
  assert.equal(result.planType, "PPO");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ "Primary Insurance Name": "UMR", DOS: row.dateOfService }]), "Input");
  const inputFile = new File([new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))], "input.xlsx");
  const output = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: "medrevenue" });
  const parsed = XLSX.read(output, { type: "buffer" });
  const values = XLSX.utils.sheet_to_json<Record<string, unknown>>(parsed.Sheets.Output)[0];
  assert.equal(values["Eff Date"], "01/01/2025");
  assert.equal(values["Plan Date"], "07/01/2024");
});

test("missing UMR date labels do not substitute DOS, plan range or benefit dates", () => {
  const missing = { ...payload, exactResponseDates: {}, healthBenefitPlanCoverage: { eligibilityBeginDate: "02/01/2024", benefitBeginDate: "03/01/2025" }, subscriberCoverageInformation: { planDate: "08/01/2026" } };
  const result = getWaystarPayer("umr", "medrevenue").parseResult(missing, row);
  assert.equal(result.effectiveDate, undefined);
  assert.equal(result.planDate, undefined);
  assert.equal(getWaystarPayer("umr", "minimax").parseResult(payload, row).planDate, payload.subscriberCoverageInformation.planDate);
  for (const project of ["minimax", "medrevenue"] as const) {
    for (const payer of ["umr", "aetna", "blue-shield", "bcbs-ppo", "scan", "medicare", "united-healthcare-all-states"]) {
      assert.equal(Boolean(getWaystarPayerProjectConfig(getWaystarProjectConfig(project), payer).exactUmrDates), project === "medrevenue" && payer === "umr");
    }
  }
});
