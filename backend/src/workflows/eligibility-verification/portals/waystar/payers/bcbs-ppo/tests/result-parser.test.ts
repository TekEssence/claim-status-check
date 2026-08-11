import assert from "node:assert/strict";
import test from "node:test";
import { bcbsPpoPayer } from "..";

test("parses BCBS PPO as a separate payer", () => {
  const result = bcbsPpoPayer.parseResult({
    overallStatus: "ACTIVE COVERAGE",
    patientInformation: { relationshipToSubscriber: "Self" },
    subscriberCoverageInformation: { insuranceType: "Commercial" },
    healthBenefitPlanCoverage: {
      coverageDescription: "PPO",
      eligibilityBeginDate: "01/01/2026",
      eligibilityEndDate: "12/31/2026",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(bcbsPpoPayer.portalPayerName, "BCBS Florida (SB590)");
  assert.equal(result.payerId, "bcbs-ppo");
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.terminationDate, "12/31/2026");
  assert.equal(result.relationshipToSubscriber, "Self");
  assert.equal(result.coverageDescription, "PPO");
  assert.equal(result.insuranceType, "Commercial");
});

test("uses BCBS PPO Plan Date when eligibility dates are absent", () => {
  const result = bcbsPpoPayer.parseResult({
    overallStatus: "ACTIVE COVERAGE",
    subscriberCoverageInformation: {
      planDate: "01/01/2023 to 12/31/9999",
      insuranceType: "Commercial",
    },
    healthBenefitPlanCoverage: { coverageDescription: "PPO" },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.effectiveDate, "01/01/2023");
  assert.equal(result.terminationDate, "12/31/9999");
  assert.equal(result.planDate, "01/01/2023 to 12/31/9999");
});