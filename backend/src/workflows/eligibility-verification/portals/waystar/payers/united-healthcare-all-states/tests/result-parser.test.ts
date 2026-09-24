import assert from "node:assert/strict";
import test from "node:test";
import { unitedHealthcareAllStatesPayer } from "..";

test("maps United Healthcare using the Aetna eligibility contract", () => {
  const result = unitedHealthcareAllStatesPayer.parseResult({
    overallStatus: "ACTIVE COVERAGE",
    subscriberCoverageInformation: {
      planBeginDate: "01/01/2026",
      insuranceType: "Managed Medicare",
    },
    healthBenefitPlanCoverage: {
      coverageDescription: "UHC MEDICARE PPO",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.relationshipToSubscriber, "Self");
  assert.equal(result.planType, "UHC MEDICARE PPO");
  assert.equal(result.insuranceType, "Managed Medicare");
  assert.deepEqual(result.benefits, []);
});

test("prefers rendered active coverage section over transient failed-at-payer status", () => {
  const result = unitedHealthcareAllStatesPayer.parseResult({
    overallStatus: "Failed at Payer",
    sectionStatuses: [
      { title: "Eligibility Response", status: "Failed at Payer" },
      { title: "Health Benefit Plan Coverage", status: "Active Coverage" },
    ],
    subscriberCoverageInformation: {
      planBeginDate: "01/01/2026",
      insuranceType: "Managed Medicare",
    },
    healthBenefitPlanCoverage: {
      coverageDescription: "UHC MEDICARE PPO",
      planStatus: "Failed at Payer",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.planType, "UHC MEDICARE PPO");
  assert.equal(result.insuranceType, "Managed Medicare");
});
