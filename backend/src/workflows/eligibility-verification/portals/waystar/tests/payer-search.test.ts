import assert from "node:assert/strict";
import test from "node:test";
import { payerSearchTerms, isExactWaystarPayerMatch } from "../portal";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";

test("MedRevenue Blue Shield searches broadly but accepts only California SB542", () => {
  const config = getWaystarPayerProjectConfig(getWaystarProjectConfig("medrevenue"), "blue-shield");
  assert.deepEqual(payerSearchTerms(config.portalPayerName!, config), ["Blue Shield"]);
  assert.equal(config.requireExactPayerSuggestionCommit, true);
  assert.equal(isExactWaystarPayerMatch("Blue Shield California (SB542)", config.portalPayerName!), true);
  assert.equal(isExactWaystarPayerMatch("Blue Shield California (SB999)", config.portalPayerName!), false);
  assert.equal(isExactWaystarPayerMatch("Blue Cross California (SB040)", config.portalPayerName!), false);
  assert.equal(isExactWaystarPayerMatch("Blue Shield", config.portalPayerName!), false);
});

test("Blue Shield search override does not change other payer searches", () => {
  for (const project of ["medrevenue", "minimax"] as const) {
    for (const [payer, config] of Object.entries(getWaystarProjectConfig(project).payers ?? {})) {
      if (project === "medrevenue" && ["blue-shield", "aetna", "umr"].includes(payer)) continue;
      assert.equal(config.payerSearchText, undefined);
      if (config.requireExactPayerSuggestionCommit && config.portalPayerName) {
        assert.deepEqual(payerSearchTerms(config.portalPayerName, config), [config.portalPayerName]);
      }
    }
  }
});

test("Humana 61101 searches using the Humana word alone", () => {
  assert.deepEqual(payerSearchTerms("Humana(61101)"), ["humana"]);
});

test("AARP Medicare Complete never searches Waystar as UHC", () => {
  const payer = "AARP Medicare Advantage Choice Plan (87726)";
  const terms = payerSearchTerms(payer);

  assert.deepEqual(terms, ["AARP Medicare Advantage Choice Plan", payer]);
  assert.equal(terms.includes("UHC"), false);
});

test("United Healthcare 87726 continues to use the UHC search", () => {
  assert.deepEqual(payerSearchTerms("United Healthcare(87726)"), [
    "UHC",
    "United Healthcare(87726)",
  ]);
});
