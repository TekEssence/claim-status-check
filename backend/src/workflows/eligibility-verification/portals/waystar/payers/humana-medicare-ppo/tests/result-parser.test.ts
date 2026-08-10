import assert from "node:assert/strict";
import test from "node:test";
import { humanaMedicarePpoPayer } from "../index";

test("Humana Medicare PPO uses the shared Waystar eligibility parser", () => {
  const result = humanaMedicarePpoPayer.parseResult({
    overallStatus: "Active Coverage",
    healthBenefitPlanCoverage: {
      eligibilityBeginDate: "01/01/2026",
      planType: "PPO",
    },
    subscriberCoverageInformation: { insuranceType: "Medicare" },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.payerId, "humana-medicare-ppo");
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.planType, "PPO");
});
test("Humana Medicare PPO falls back to Plan Begin Date", () => {
  const result = humanaMedicarePpoPayer.parseResult({
    subscriberCoverageInformation: {
      planBeginDate: "01/01/2018",
      insuranceType: "Commercial",
    },
    healthBenefitPlanCoverage: {
      planType: "PPO",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.effectiveDate, "01/01/2018");
});

test("Humana Medicare PPO keeps the eligibility effective date when both dates exist", () => {
  const result = humanaMedicarePpoPayer.parseResult({
    subscriberCoverageInformation: {
      planBeginDate: "01/01/2018",
    },
    healthBenefitPlanCoverage: {
      eligibilityBeginDate: "02/01/2020",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.effectiveDate, "02/01/2020");
});