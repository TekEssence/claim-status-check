import assert from "node:assert/strict";
import test from "node:test";
import { cignaOpenAccessPlusPayer } from "..";

test("configures Cigna Open Access Plus as a separate Waystar payer", () => {
  assert.equal(cignaOpenAccessPlusPayer.id, "cigna-open-access-plus");
  assert.equal(cignaOpenAccessPlusPayer.name, "Cigna Open Access Plus");
  assert.equal(cignaOpenAccessPlusPayer.portalPayerName, "Cigna Health Plans (62308)");
  assert.equal(cignaOpenAccessPlusPayer.credentialProject, "FL2");
});

test("parses Cigna Open Access Plus eligibility independently", () => {
  const result = cignaOpenAccessPlusPayer.parseResult({
    overallStatus: "ACTIVE COVERAGE",
    patientInformation: { relationshipToSubscriber: "Self" },
    subscriberCoverageInformation: { insuranceType: "Commercial" },
    healthBenefitPlanCoverage: {
      coverageDescription: "Open Access Plus",
      eligibilityBeginDate: "01/01/2026",
      eligibilityEndDate: "12/31/2026",
      planType: "Preferred Provider Organization (PPO)",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.payerId, "cigna-open-access-plus");
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.terminationDate, "12/31/2026");
  assert.equal(result.relationshipToSubscriber, "Self");
  assert.equal(result.insuranceType, "Commercial");
  assert.equal(result.coverageDescription, "Open Access Plus");
});
