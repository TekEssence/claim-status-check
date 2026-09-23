import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildWaystarOutputWorkbook } from "../output";
import { routeWaystarRowsByPayer } from "../input";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";
import { getWaystarPayer } from "../payer-registry";
import { payerSearchTerms, isExactWaystarPayerMatch } from "../portal";

test("MedRevenue CIGNA selects Cigna Health Plans 62308 before member-prefix routing", () => {
  const project = getWaystarProjectConfig("medrevenue");
  const id = "cigna-open-access-plus";
  const config = getWaystarPayerProjectConfig(project, id);
  for (const name of ["CIGNA", "Cigna", "cigna"]) {
    for (const member of ["XTEST123", "912345", "ATEST123"]) {
      const routing = routeWaystarRowsByPayer([{ "Primary Insurance Name": name, "Member ID": member }], { projectConfig: project });
      assert.deepEqual(routing.unsupportedRows, []);
      assert.equal(routing.batches[0].payerId, id);
    }
  }
  assert.equal(config.portalPayerName, "Cigna Health Plans (62308)");
  assert.deepEqual(payerSearchTerms(config.portalPayerName!, config), ["Cigna"]);
  assert.equal(config.requireExactPayerSuggestionCommit, true);
  assert.equal(isExactWaystarPayerMatch("Cigna Health Plans(62308)", config.portalPayerName!), true);
  assert.equal(isExactWaystarPayerMatch("Cigna Health Plans (99999)", config.portalPayerName!), false);
  const medrevenue = getWaystarPayer(id, "medrevenue");
  const minimax = getWaystarPayer(id, "minimax");
  assert.equal(medrevenue.credentialProject, undefined);
  assert.equal(minimax.credentialProject, "FL2");
  const row = { originalIndex: 2, raw: {} };
  const payload = { overallStatus: "Active Coverage" };
  assert.deepEqual(medrevenue.parseResult(payload, row), minimax.parseResult(payload, row));
  assert.equal(getWaystarPayerProjectConfig(getWaystarProjectConfig("minimax"), id).payerSearchText, undefined);
});

test("only MedRevenue Cigna writes subscriber Plan Begin Date to Excel Plan Date", async () => {
  const id = "cigna-open-access-plus";
  const row = { originalIndex: 2, raw: {}, dateOfService: "09/07/2026" };
  const payload = {
    overallStatus: "Active Coverage",
    subscriberCoverageInformation: { planBeginDate: "01/01/2025", planDate: "08/14/2026" },
    healthBenefitPlanCoverage: { eligibilityBeginDate: "02/01/2025", benefitBeginDate: "03/01/2025" },
  };
  const handler = getWaystarPayer(id, "medrevenue");
  const original = getWaystarPayer(id, "minimax").parseResult(payload, row);
  const result = handler.parseResult(payload, row);
  assert.equal(result.planDate, "01/01/2025");
  assert.equal(original.planDate, "08/14/2026");
  assert.deepEqual({ ...result, planDate: original.planDate }, original);
  assert.equal(handler.parseResult({ ...payload, subscriberCoverageInformation: { planDate: "08/14/2026" } }, row).planDate, undefined);
  for (const projectId of ["medrevenue", "minimax"] as const) {
    for (const payerId of [id, "aetna", "umr", "medicare", "blue-shield", "bcbs-ppo", "scan", "united-healthcare-all-states"]) {
      assert.equal(Boolean(getWaystarPayerProjectConfig(getWaystarProjectConfig(projectId), payerId).exactCignaPlanDate), projectId === "medrevenue" && payerId === id);
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ "Primary Insurance Name": "CIGNA" }]), "Input");
  const inputFile = new File([new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))], "input.xlsx");
  const output = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: "medrevenue" });
  const parsed = XLSX.read(output, { type: "buffer" });
  const values = XLSX.utils.sheet_to_json<Record<string, unknown>>(parsed.Sheets.Output)[0];
  assert.equal(values["Plan Date"], "01/01/2025");
});
