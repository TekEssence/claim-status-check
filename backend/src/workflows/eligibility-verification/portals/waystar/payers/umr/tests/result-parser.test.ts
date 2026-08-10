import assert from "node:assert/strict";
import test from "node:test";
import { umrPayer } from "../index";

test("UMR uses Plan Network Name and falls back to Plan Begin Date", () => {
  const result = umrPayer.parseResult({
    overallStatus: "Active Coverage",
    subscriberCoverageInformation: {
      planNetworkName: "UNITEDHEALTHCARE CHOICE PLUS",
      planBeginDate: "01/01/2025",
      insuranceType: "Commercial",
    },
    healthBenefitPlanCoverage: {
      coverageDescription: "Health Benefit Plan Coverage",
      planType: "PPO",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.planType, "UNITEDHEALTHCARE CHOICE PLUS");
  assert.equal(result.effectiveDate, "01/01/2025");
});

test("UMR keeps the eligibility effective date when both dates are present", () => {
  const result = umrPayer.parseResult({
    subscriberCoverageInformation: {
      planNetworkName: "UNITEDHEALTHCARE CHOICE PLUS",
      planBeginDate: "01/01/2025",
    },
    healthBenefitPlanCoverage: {
      eligibilityBeginDate: "02/01/2025",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.effectiveDate, "02/01/2025");
});
