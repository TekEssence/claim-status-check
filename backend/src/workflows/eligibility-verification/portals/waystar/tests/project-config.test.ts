import assert from "node:assert/strict";
import test from "node:test";
import { getWaystarPayerProjectConfig, getWaystarProjectConfig } from "../config/projects";
import { medicarePayer } from "../payers/medicare";
import { createWaystarRunner } from "../scraper";
import { routeWaystarRowsByPayer } from "../input";

function file(name: string): File {
  return new File([new Uint8Array([1])], name);
}

test("Minimax Waystar configuration preserves all established payer defaults", () => {
  const config = getWaystarProjectConfig("minimax");
  assert.equal(config.id, "minimax");
  assert.deepEqual(getWaystarPayerProjectConfig(config, medicarePayer.id), {});
  assert.equal(medicarePayer.portalPayerName, "Medicare A & B Eligibility (All States) (Z1073)");
});

test("MedRevenue resolves the same Medicare payer through project configuration", () => {
  const config = getWaystarProjectConfig("medrevenue");
  const medicareConfig = getWaystarPayerProjectConfig(config, "medicare");
  assert.equal(config.id, "medrevenue");
  assert.ok(config.payers?.medicare);
  assert.equal(medicarePayer.id, "medicare");
  assert.equal(medicareConfig.skipProviderHandling, true);
  assert.equal(medicareConfig.useDateOfServiceForPlanDates, true);
  assert.equal(medicareConfig.fillDateOfBirth, true);
  assert.equal(medicareConfig.serviceTypeDirectValue, "30");
  assert.equal(medicareConfig.extractFullPayerResponse, true);
  assert.equal(medicareConfig.selectorFallbacks?.planDateFrom, "#txtPlanFrom");
  assert.equal(medicareConfig.selectorFallbacks?.planDateTo, "#txtPlanTo");
  assert.equal(medicareConfig.selectorFallbacks?.dateOfBirth, "#DOB");
});

test("Waystar runner accepts both projects without another payer runner", () => {
  const runner = createWaystarRunner();
  for (const projectId of ["minimax", "medrevenue"]) {
    const input = new FormData();
    input.set("projectId", projectId);
    input.set("inputFile", file("input.xlsx"));
    input.set("credentialFile", file("credentials.xlsx"));
    assert.equal(runner.validateInput(input).projectId, projectId);
  }
});

test("project input mappings route through the shared Medicare handler", () => {
  const routing = routeWaystarRowsByPayer([
    { "MedRevenue Insurance": "Medicare", "Patient First Name": "Jane", "Patient Last Name": "Doe" },
  ], {
    projectConfig: {
      ...getWaystarProjectConfig("medrevenue"),
      inputColumnMappings: { insuranceName: ["MedRevenue Insurance"] },
    },
  });

  assert.equal(routing.batches[0]?.payerId, medicarePayer.id);
});

test("MedRevenue configuration does not enable unrelated Waystar payers", () => {
  const routing = routeWaystarRowsByPayer([
    { "Payer Name": "Aetna", "Patient First Name": "Jane", "Patient Last Name": "Doe" },
  ], { projectConfig: getWaystarProjectConfig("medrevenue") });

  assert.equal(routing.batches.length, 0);
  assert.equal(routing.unsupportedRows.length, 1);
});

test("MedRevenue config selects Blue Cross California without changing the registered BCBS payer", () => {
  const config = getWaystarProjectConfig("medrevenue");
  const blueCrossConfig = getWaystarPayerProjectConfig(config, "bcbs-ppo");
  assert.equal(blueCrossConfig.portalPayerName, "Blue Cross California (SB040)");
  assert.equal(blueCrossConfig.requireExactPayerSuggestionCommit, true);
  assert.equal(blueCrossConfig.skipProviderHandling, true);
  assert.equal(blueCrossConfig.useDateOfServiceForPlanDates, true);
  assert.equal(blueCrossConfig.planDateToOptional, true);
  assert.equal(blueCrossConfig.serviceTypeDirectValue, "30");
});

test("MedRevenue routes Blue Cross only when Member ID starts alphabetically", () => {
  const routing = routeWaystarRowsByPayer([
    { "Primary Insurance Name": "Blue Cross California", "Member ID": "ABC123" },
    { "Primary Insurance Name": "Blue Cross", "Member ID": "1ABC23" },
    { "Primary Insurance Name": "Blue Cross California", "Member ID": "123456" },
  ], { projectConfig: getWaystarProjectConfig("medrevenue") });

  assert.equal(routing.batches.length, 1);
  assert.equal(routing.batches[0]?.payerId, "bcbs-ppo");
  assert.deepEqual(routing.batches[0]?.rows.map((row) => row.originalIndex), [2]);
  assert.deepEqual(routing.unsupportedRows.map((row) => row.rowIndex), [3, 4]);
});
