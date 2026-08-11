import assert from "node:assert/strict";
import test from "node:test";
import { aetnaMedicarePpoPayer } from "..";

test("maps Aetna Medicare PPO using the BayCare eligibility contract", () => {
  const result = aetnaMedicarePpoPayer.parseResult({
    overallStatus: "ACTIVE COVERAGE",
    subscriberCoverageInformation: {
      planBeginDate: "01/01/2026",
      planEndDate: "12/31/2026",
      insuranceType: "Commercial",
    },
    healthBenefitPlanCoverage: {
      planStatus: "ACTIVE",
      coverageDescription: "AETNA MEDICARE PPO",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.terminationDate, "12/31/2026");
  assert.equal(result.relationshipToSubscriber, "Self");
  assert.equal(result.planType, "AETNA MEDICARE PPO");
  assert.equal(result.insuranceType, "Commercial");
  assert.deepEqual(result.benefits, []);
});
test("reports inactive Aetna coverage even when the overall response contains a payer error", () => {
  const result = aetnaMedicarePpoPayer.parseResult({
    overallStatus: "Failed at Payer",
    subscriberCoverageInformation: {
      planEndDate: "06/30/2025",
      insuranceType: "Managed Medicare",
    },
    healthBenefitPlanCoverage: {
      planStatus: "INACTIVE",
      coverageDescription: "AETNA MEDICARE PPO",
    },
  }, { originalIndex: 3, raw: {} });

  assert.equal(result.coverageStatus, "inactive");
  assert.equal(result.terminationDate, "06/30/2025");
  assert.equal(result.planType, "AETNA MEDICARE PPO");
  assert.equal(result.insuranceType, "Managed Medicare");
});