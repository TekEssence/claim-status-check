import assert from "node:assert/strict";
import test from "node:test";
import { parseBlueCrossBlueShieldResult } from "..";

test("parses inactive Health Benefit Plan Coverage values", () => {
  const result = parseBlueCrossBlueShieldResult(
    {
      healthBenefitPlanCoverage: {
        planType: "Preferred Provider Organization (PPO)",
        planStatus: "INACTIVE",
        coverageDescription: "PREFERRED PROVIDER OPTION MEDICAL",
        eligibilityBeginDate: "03/01/2023",
        eligibilityEndDate: "04/30/2024",
      },
    },
    {
      originalIndex: 2,
      raw: {},
    },
    "blue-cross-blue-shield-texas",
  );

  assert.equal(result.coverageStatus, "inactive");
  assert.equal(result.planType, "PPO");
  assert.equal(result.planName, "PREFERRED PROVIDER OPTION MEDICAL");
  assert.equal(result.planStatus, "INACTIVE");
  assert.equal(result.effectiveDate, "03/01/2023");
  assert.equal(result.terminationDate, "04/30/2024");
  assert.deepEqual(result.benefits, [
    {
      serviceType: "30 - Health Benefit Plan Coverage",
      coverageStatus: "inactive",
      notes: "INACTIVE",
    },
  ]);
});
