import assert from "node:assert/strict";
import test from "node:test";
import { aetnaPayer } from "..";

test("configures AETNA as a separate Waystar payer", () => {
  assert.equal(aetnaPayer.id, "aetna");
  assert.equal(aetnaPayer.name, "AETNA");
  assert.equal(aetnaPayer.portalPayerName, "Aetna (60054)");
  assert.equal(aetnaPayer.credentialProject, "FL2");
});

test("parses AETNA eligibility independently", () => {
  const result = aetnaPayer.parseResult({
    overallStatus: "ACTIVE COVERAGE",
    patientInformation: { relationshipToSubscriber: "Self" },
    subscriberCoverageInformation: { insuranceType: "Commercial" },
    healthBenefitPlanCoverage: {
      coverageDescription: "Open Choice PPO",
      eligibilityBeginDate: "01/01/2026",
      eligibilityEndDate: "12/31/2026",
      planType: "Preferred Provider Organization (PPO)",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.payerId, "aetna");
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.terminationDate, "12/31/2026");
  assert.equal(result.insuranceType, "Commercial");
  assert.equal(result.coverageDescription, "Open Choice PPO");
});
