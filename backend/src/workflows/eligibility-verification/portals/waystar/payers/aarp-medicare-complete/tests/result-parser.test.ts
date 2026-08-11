import assert from "node:assert/strict";
import test from "node:test";
import { aarpMedicareCompletePayer } from "..";

test("maps AARP Medicare Complete with its independent payer parser", () => {
  const result = aarpMedicareCompletePayer.parseResult({
    overallStatus: "ACTIVE COVERAGE",
    subscriberCoverageInformation: {
      planBeginDate: "08/01/2025 to 07/31/2026",
      insuranceType: "Managed Medicare",
      otherInsurance: "Other Payer",
      otherInsuranceEffectiveDate: "01/01/2025",
    },
    healthBenefitPlanCoverage: {
      coverageDescription: "AARP MEDICARE ADVANTAGE CHOICE PLAN",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.payerId, "aarp-medicare-complete");
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.effectiveDate, "08/01/2025");
  assert.equal(result.terminationDate, "07/31/2026");
  assert.equal(result.otherInsurance, "Other Payer");
  assert.equal(result.otherInsuranceEffectiveDate, "01/01/2025");
  assert.equal(result.relationshipToSubscriber, "Self");
  assert.equal(result.planType, "AARP MEDICARE ADVANTAGE CHOICE PLAN");
  assert.equal(result.insuranceType, "Managed Medicare");
  assert.deepEqual(result.benefits, []);
});

test("preserves inactive AARP coverage", () => {
  const result = aarpMedicareCompletePayer.parseResult({
    overallStatus: "INACTIVE COVERAGE",
  }, { originalIndex: 3, raw: {} });

  assert.equal(result.coverageStatus, "inactive");
});

