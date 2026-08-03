import assert from "node:assert/strict";
import test from "node:test";
import { applyWaystarResultDefaults, describeEligibilityExtraction } from "../scraper";
import type { EligibilityResult } from "../../../types";

function compactResult(payerId: string): EligibilityResult {
  return {
    rowIndex: 2,
    payerId,
    coverageStatus: "active",
    effectiveDate: "01/01/2026",
    terminationDate: "12/31/2026",
    relationshipToSubscriber: "Self",
    planType: "PPO",
    insuranceType: "Commercial",
    benefits: [],
  };
}

test("reports only compact output fields for BCBS PPO", () => {
  assert.deepEqual(describeEligibilityExtraction(compactResult("bcbs-ppo")), {
    extracted: ["Coverage Status", "Eff Date", "End Date", "Relationship to Subscriber", "Plan Type", "Bot Insurance Type"],
    missing: [],
  });
});

test("reports only compact output fields for Cigna Open Access Plus", () => {
  assert.deepEqual(describeEligibilityExtraction(compactResult("cigna-open-access-plus")), {
    extracted: ["Coverage Status", "Eff Date", "End Date", "Relationship to Subscriber", "Plan Type", "Bot Insurance Type"],
    missing: [],
  });
});

test("defaults a missing Waystar relationship to Self", () => {
  const result = compactResult("cigna-open-access-plus");
  result.relationshipToSubscriber = undefined;

  assert.equal(
    applyWaystarResultDefaults(result, { originalIndex: 2, raw: {} }).relationshipToSubscriber,
    "Self",
  );
});

test("preserves an explicit input relationship when the portal omits it", () => {
  const result = compactResult("bcbs-ppo");
  result.relationshipToSubscriber = undefined;

  assert.equal(
    applyWaystarResultDefaults(result, {
      originalIndex: 2,
      relationshipToSubscriber: "Child",
      raw: {},
    }).relationshipToSubscriber,
    "Child",
  );
});