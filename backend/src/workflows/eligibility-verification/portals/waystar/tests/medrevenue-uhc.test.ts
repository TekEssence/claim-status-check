import assert from "node:assert/strict";
import test from "node:test";
import { routeWaystarRowsByPayer } from "../input";
import { getWaystarPayer } from "../payer-registry";
import { getWaystarPayerProjectConfig, getWaystarProjectConfig } from "../config/projects";
import { findWaystarCredentialsForPayer, type WaystarCredentials } from "../credentials";
import { unitedHealthcareAllStatesPayer } from "../payers/united-healthcare-all-states";
import { isExactWaystarPayerMatch } from "../portal";

test("MedRevenue routes UHC names, medical groups and 9 prefixes to UHC", () => {
  for (const name of ["United Healthcare", "UNITED HEALTH CARE", "UnitedHealthcare", "UHC", "Upland   Medical Group", "Regal Medical Group", "United Healthcare PPO"]) {
    const routing = routeWaystarRowsByPayer([{ "Primary Insurance Name": name, "Member ID": "A123" }], { projectConfig: getWaystarProjectConfig("medrevenue") });
    assert.equal(routing.batches[0]?.payerId, "united-healthcare-all-states", name);
  }
  for (const name of ["Blue Cross", "Unknown", ""]) {
    const routing = routeWaystarRowsByPayer([{ "Primary Insurance Name": name, "Member ID": " 912345 " }], { projectConfig: getWaystarProjectConfig("medrevenue") });
    assert.equal(routing.batches[0]?.payerId, "united-healthcare-all-states", name);
    assert.equal(routing.batches[0].rows[0].memberId, "912345");
  }
  const routing = routeWaystarRowsByPayer([
    { Payer: "United Healthcare", "Member ID": "X123" },
    { Payer: "Unknown", "Member ID": "A9123" },
  ], { projectConfig: getWaystarProjectConfig("medrevenue") });
  assert.equal(routing.batches[0]?.payerId, "blue-shield");
  assert.equal(routing.unsupportedRows.length, 1);
});

test("UHC MedRevenue configuration uses screenshot payer and single DOS date without changing Minimax", () => {
  const config = getWaystarPayerProjectConfig(getWaystarProjectConfig("medrevenue"), "united-healthcare-all-states");
  assert.equal(config.portalPayerName, "UHC (87726)");
  assert.equal(isExactWaystarPayerMatch(config.portalPayerName!, "UHC (87726)"), true);
  assert.equal(config.useDateOfServiceForPlanDates, true);
  assert.equal(config.fillPlanDatesBeforeServiceType, true);
  assert.equal(config.planDateToOptional, true);
  assert.equal(config.preserveMemberId, true);
  assert.equal(config.memberIdAndDobOnly, true);
  assert.equal(config.typePlanDate, true);
  assert.deepEqual(getWaystarPayer("united-healthcare-all-states", "medrevenue").requiredFields, ["memberId", "dateOfBirth"]);
  assert.ok(getWaystarPayer("united-healthcare-all-states", "minimax").requiredFields.includes("patientLastName"));
  assert.equal(config.serviceTypeDirectValue, "30");
  assert.deepEqual(getWaystarPayerProjectConfig(getWaystarProjectConfig("minimax"), "united-healthcare-all-states"), {});
  assert.equal(getWaystarPayer("united-healthcare-all-states", "minimax"), unitedHealthcareAllStatesPayer);
  for (const projectConfig of [undefined, getWaystarProjectConfig("minimax")]) {
    const routing = routeWaystarRowsByPayer([
      { Payer: "Medicare", "Member ID": "9123" },
      { Payer: "Regal Medical Group", "Member ID": "9123" },
      { Payer: "Upland Medical Group", "Member ID": "9123" },
    ], { projectConfig });
    assert.equal(routing.batches[0]?.payerId, "medicare");
    assert.equal(routing.unsupportedRows.length, 2);
  }
});

test("MedRevenue UHC prefers its own login and otherwise reuses the MedRevenue Blue Cross account", () => {
  const payer = getWaystarPayer("united-healthcare-all-states", "medrevenue");
  const cross: WaystarCredentials = { username: "cross", password: "test", loginUrl: "https://example.com", serviceTypeCode: "30", verificationAnswers: [], project: "MedRevenue", portal: "Waystar", payer: "BCBS PPO" };
  const uhc = { ...cross, username: "uhc", payer: "UHC" };
  const minimax = { ...cross, username: "minimax", project: "FL2" };
  assert.equal(findWaystarCredentialsForPayer([minimax, cross], payer, "medrevenue"), cross);
  assert.equal(findWaystarCredentialsForPayer([cross, uhc], payer, "medrevenue"), uhc);
  assert.equal(findWaystarCredentialsForPayer([minimax], payer, "medrevenue", { allowUnscopedCredentials: true }), null);
});

test("MedRevenue UHC retains response metadata and existing coverage extraction without substituting DOS for COB", () => {
  const payload = { overallStatus: "Active Coverage", subscriberCoverageInformation: { planDate: "09/02/2026", planBeginDate: "01/01/2026 to 12/31/2026" }, fullPayerResponse: { sections: [] } };
  const row = { originalIndex: 2, raw: {} };
  const existing = unitedHealthcareAllStatesPayer.parseResult(payload, row);
  const result = getWaystarPayer("united-healthcare-all-states", "medrevenue").parseResult(payload, row);
  assert.equal(result.planDate, undefined);
  assert.equal(result.effectiveDate, existing.effectiveDate);
  assert.equal(result.terminationDate, existing.terminationDate);
  assert.deepEqual(result.metadata?.fullPayerResponse, payload.fullPayerResponse);
});
