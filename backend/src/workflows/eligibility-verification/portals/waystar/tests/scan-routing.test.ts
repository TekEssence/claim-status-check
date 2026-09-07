import assert from "node:assert/strict";
import test from "node:test";
import { getWaystarProjectConfig } from "../config/projects";
import { routeWaystarRowsByPayer } from "../input";
import { getWaystarPayer, matchWaystarPayer } from "../payer-registry";
import { isExactWaystarPayerMatch } from "../portal";

test("MedRevenue primary SCAN insurance overrides numeric prefixes", () => {
  const rows = ["SCAN", "scan", "Scan Health Plan", "Scan Health Plan - California(72261)"]
    .flatMap((name) => ["912345", "A12345"].map((memberId) => ({
      Payer: "UHC", "Primary Insurance Name": name, "Member ID": memberId,
    })));
  const routing = routeWaystarRowsByPayer(rows, { projectConfig: getWaystarProjectConfig("medrevenue") });
  assert.equal(routing.unsupportedRows.length, 0);
  assert.equal(routing.batches.length, 1);
  assert.equal(routing.batches[0].payerId, "scan");
  assert.equal(routing.batches[0].rows.length, rows.length);
});

test("SCAN selects only California 72261 and remains unavailable to Minimax", () => {
  const payer = getWaystarPayer("scan", "medrevenue");
  assert.equal(payer.portalPayerName, "Scan Health Plan - California(72261)");
  assert.equal(getWaystarProjectConfig("medrevenue").payers?.scan.requireExactPayerSuggestionCommit, true);
  assert.equal(isExactWaystarPayerMatch(payer.portalPayerName, "Scan Health Plan - California (72261)"), true);
  assert.equal(isExactWaystarPayerMatch(payer.portalPayerName, "Scan Health Plan (99999)"), false);
  assert.equal(matchWaystarPayer("SCAN"), null);
  assert.throws(() => getWaystarPayer("scan", "minimax"));
  const routing = routeWaystarRowsByPayer([{ "Primary Insurance Name": "SCAN" }], {
    projectConfig: getWaystarProjectConfig("minimax"),
  });
  assert.equal(routing.unsupportedRows.length, 1);
});
