import assert from "node:assert/strict";
import test from "node:test";
import { bayCarePlusMedicareAdvantagePayer } from "..";

test("maps the BayCare eligibility response to the requested fields", () => {
  const result = bayCarePlusMedicareAdvantagePayer.parseResult({
    overallStatus: "ACTIVE",
    patientInformation: { relationshipToSubscriber: "Self" },
    subscriberCoverageInformation: {
      planBeginDate: "10/01/2025",
      planEndDate: "09/30/2026",
      insuranceType: "Commercial",
      otherInsurance: "Other Carrier",
      otherInsuranceEffectiveDate: "01/01/2025",
    },
    healthBenefitPlanCoverage: {
      planStatus: "ACTIVE",
      coverageDescription: "H2235002 BAYCAREPLUS REWARDS",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "10/01/2025");
  assert.equal(result.terminationDate, "09/30/2026");
  assert.equal(result.planType, "H2235002 BAYCAREPLUS REWARDS");
  assert.equal(result.insuranceType, "Commercial");
  assert.equal(result.otherInsurance, "Other Carrier");
  assert.equal(result.otherInsuranceEffectiveDate, "01/01/2025");
  assert.equal(result.relationshipToSubscriber, "Self");
});
