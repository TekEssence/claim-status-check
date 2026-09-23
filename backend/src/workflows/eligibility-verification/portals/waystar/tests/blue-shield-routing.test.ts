import assert from "node:assert/strict";
import test from "node:test";
import { routeWaystarRowsByPayer } from "../input";
import { getWaystarProjectConfig } from "../config/projects";
import { getWaystarPayerProjectConfig } from "../config/projects";
import { isExactWaystarPayerMatch } from "../portal";
import { applyMedRevenueBlueCrossResultMappings, describeEligibilityExtraction } from "../scraper";
import { buildWaystarOutputWorkbook } from "../output";
import * as XLSX from "xlsx";
import type { Page } from "playwright-core";
import { verifyWaystarMemberIdAndDob } from "../portal";
import { WAYSTAR_SELECTORS } from "../selectors";

test("only MedRevenue Blue Shield requires Member ID and DOB without patient names", () => {
  assert.deepEqual(getWaystarPayer("blue-shield", "medrevenue").requiredFields, ["memberId", "dateOfBirth"]);
  for (const projectId of ["minimax", "medrevenue"] as const) {
    for (const payerId of ["bcbs-ppo", "medicare", "blue-shield"]) {
      const config = getWaystarPayerProjectConfig(getWaystarProjectConfig(projectId), payerId);
      assert.equal(Boolean(config.memberIdAndDobOnly), projectId === "medrevenue" && payerId === "blue-shield");
    }
    assert.ok(getWaystarPayer("bcbs-ppo", projectId).requiredFields.includes("patientLastName"));
  }
});

test("Blue Shield verification accesses no name fields and detects a cleared DOB", async () => {
  let dob = "9/2/1980";
  const page = { locator(selector: string) {
    assert.ok([WAYSTAR_SELECTORS.inquiry.memberId, WAYSTAR_SELECTORS.inquiry.dateOfBirth].includes(selector as typeof WAYSTAR_SELECTORS.inquiry.memberId));
    return { first: () => ({ inputValue: async () => selector === WAYSTAR_SELECTORS.inquiry.memberId ? "X123" : dob }) };
  } } as unknown as Page;
  await verifyWaystarMemberIdAndDob(page, "X123", "09/02/1980");
  dob = "";
  await assert.rejects(verifyWaystarMemberIdAndDob(page, "X123", "09/02/1980"), /did not retain/);
});
import { getWaystarPayer, matchWaystarPayer } from "../payer-registry";

test("MedRevenue Blue Shield names always select SB542 and X prefixes use SB542 except Blue Cross", () => {
  const projectConfig = getWaystarProjectConfig("medrevenue");
  const cases = [
    ...["Blue Shield", "BLUESHILED", "BlueShield"].flatMap(name =>
      ["912345", "A12345", "X12345"].map(id => ({ name, id, payer: "blue-shield" }))),
    ...["SCAN", "United Healthcare", "Medicare", "Unknown", ""].map(name =>
      ({ name, id: " x12345 ", payer: "blue-shield" })),
    ...["Blue Cross", "BLUE CROSS OF CALIFORNIA", "Blue Cross California"].map(name =>
      ({ name, id: "X12345", payer: "bcbs-ppo" })),
  ];
  for (const { name, id, payer } of cases) {
    const routing = routeWaystarRowsByPayer([
      { "Primary Insurance Name": name, "Member ID": id },
    ], { projectConfig });
    assert.deepEqual(routing.unsupportedRows, [], name);
    assert.equal(routing.batches[0]?.payerId, payer, `${name} / ${id}`);
    assert.equal(getWaystarPayerProjectConfig(projectConfig, payer).portalPayerName,
      payer === "blue-shield" ? "Blue Shield California(SB542)" : "Blue Cross California (SB040)");
  }
});

test("MedRevenue preserves explicit Blue Cross names ahead of the X-prefix fallback", () => {
  const rows = [
    { "Primary Insurance Payer": "BLUE SHIELD", "Member ID": "123" },
    { "Primary Insurance Payer": "California BlueShield PPO", "Member ID": "A123" },
    { "Primary Insurance Payer": "Medicare", "Member ID": "X123" },
    { "Primary Insurance Payer": "BLUE CROSS", "Member ID": " x456 " },
    { "Primary Insurance Payer": "Unknown", "Member ID": "X789" },
    { "Primary Insurance Payer": "", "Member ID": "X999" },
    { "Primary Insurance Payer": "BLUE CROSS", "Member ID": "A123" },
    { "Primary Insurance Payer": "Medicare", "Member ID": "M123" },
    { "Primary Insurance Payer": "Unknown", "Member ID": "AX123" },
    { "Primary Insurance Payer": "NotBlueShield", "Member ID": "123" },
  ];
  const routing = routeWaystarRowsByPayer(rows, { projectConfig: getWaystarProjectConfig("medrevenue") });
  assert.deepEqual(routing.batches.map((batch) => [batch.payerId, batch.rows.map((row) => row.originalIndex)]), [
    ["blue-shield", [2, 3, 4, 6, 7]],
    ["bcbs-ppo", [5, 8]],
    ["medicare", [9]],
  ]);
  assert.deepEqual(routing.unsupportedRows.map((row) => row.rowIndex), [10, 11]);
});

test("MedRevenue Blue Cross variants with X-prefixed IDs select SB040, not SB542", () => {
  for (const name of ["BLUE CROSS", "BLUE CROSS OF CALIFORNIA", "Blue Cross California"]) {
    const routing = routeWaystarRowsByPayer([
      { "Primary Insurance name": name, "member ID#": "XTEST123" },
      { "Primary Insurance name": "BLUESHILED", "member ID#": "XTEST456" },
    ], { projectConfig: getWaystarProjectConfig("medrevenue") });
    assert.deepEqual(routing.unsupportedRows, []);
    assert.deepEqual(routing.batches.map(batch => batch.payerId), ["bcbs-ppo", "blue-shield"]);
    assert.equal(getWaystarPayerProjectConfig(getWaystarProjectConfig("medrevenue"), routing.batches[0].payerId).portalPayerName, "Blue Cross California (SB040)");
    assert.equal(getWaystarPayerProjectConfig(getWaystarProjectConfig("medrevenue"), routing.batches[1].payerId).portalPayerName, "Blue Shield California(SB542)");
  }
});

test("Minimax and default routing retain Medicare even when Member ID starts with X", () => {
  for (const projectConfig of [undefined, getWaystarProjectConfig("minimax")]) {
    const routing = routeWaystarRowsByPayer([
      { Payer: "Medicare", "Member ID": "X123" },
      { Payer: "Blue Shield", "Member ID": "X456" },
    ], { projectConfig });
    assert.deepEqual(routing.batches.map((batch) => [batch.payerId, batch.rows.length]), [["medicare", 1]]);
    assert.equal(routing.unsupportedRows.length, 1);
  }
  assert.equal(matchWaystarPayer("Blue Shield"), null);
  assert.throws(() => getWaystarPayer("blue-shield", "minimax"));
  assert.equal(getWaystarPayer("blue-shield", "medrevenue").name, "Blue Shield");
});

test("Blue Shield parsing retains its distinct payer identity", () => {
  const payer = getWaystarPayer("blue-shield", "medrevenue");
  const result = payer.parseResult({ overallStatus: "Active Coverage" }, { originalIndex: 2, raw: {} });
  assert.equal(result.payerId, "blue-shield");
});

test("MedRevenue Blue Shield selects SB542 and fills available DOS dates using Blue Cross processing settings", () => {
  const project = getWaystarProjectConfig("medrevenue");
  const shield = getWaystarPayerProjectConfig(project, "blue-shield");
  const cross = getWaystarPayerProjectConfig(project, "bcbs-ppo");
  assert.equal(shield.portalPayerName, "Blue Shield California(SB542)");
  assert.equal(isExactWaystarPayerMatch(shield.portalPayerName!, "Blue Shield California (SB542)"), true);
  assert.equal(isExactWaystarPayerMatch(shield.portalPayerName!, cross.portalPayerName!), false);
  assert.equal(shield.planDateToOptional, true);
  assert.equal(shield.selectorFallbacks?.planDateTo, "#txtPlanTo");
  for (const key of ["requireExactPayerSuggestionCommit", "skipProviderHandling", "useDateOfServiceForPlanDates", "fillPlanDatesBeforeServiceType", "fillDateOfBirth", "serviceTypeDirectValue", "extractSecondaryCoverage", "responsePlanDateSectionTitle"] as const) {
    assert.equal(shield[key], cross[key], key);
  }
  assert.deepEqual(getWaystarPayerProjectConfig(getWaystarProjectConfig("minimax"), "bcbs-ppo"), {});
});

test("Blue Shield and Blue Cross produce identical extracted fields and MedRevenue workbooks", async () => {
  const row = { originalIndex: 2, raw: {}, dateOfService: "09/02/2026" };
  const payload = {
    overallStatus: "Active Coverage",
    subscriberCoverageInformation: { planDate: "01/01/2026 to 12/31/2026" },
    fullPayerResponse: {
      secondaryCoverageInformation: { rows: [
        { label: "Coverage Description", value: "Secondary plan" },
        { label: "COB Date", value: "01/01/2026" },
        { label: "Group or Policy Number", value: "TEST123" },
        { label: "Service Type", value: "Health Benefit Plan Coverage" },
      ] },
    },
  };
  const cross = applyMedRevenueBlueCrossResultMappings(getWaystarPayer("bcbs-ppo", "medrevenue").parseResult(payload, row));
  const shield = applyMedRevenueBlueCrossResultMappings(getWaystarPayer("blue-shield", "medrevenue").parseResult(payload, row));
  assert.deepEqual({ ...shield, payerId: "bcbs-ppo" }, cross);
  assert.equal(shield.effectiveDate, "01/01/2026");
  assert.equal(shield.terminationDate, "12/31/2026");
  assert.equal(shield.metadata?.medRevenueSecondaryCoverageDescription, "Secondary plan");
  assert.deepEqual(describeEligibilityExtraction(shield), describeEligibilityExtraction(cross));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["DOS"], ["09/02/2026"]]), "Input");
  const inputFile = new File([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], "test.xlsx");
  const outputRows = [];
  for (const result of [cross, shield]) {
    const output = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: "medrevenue" });
    const book = XLSX.read(output, { type: "buffer" });
    outputRows.push(XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets.Output, { defval: "" }));
  }
  assert.deepEqual(outputRows[1], outputRows[0]);
  assert.equal(outputRows[1][0]["Secondary Coverage Description"], "Secondary plan");
});
