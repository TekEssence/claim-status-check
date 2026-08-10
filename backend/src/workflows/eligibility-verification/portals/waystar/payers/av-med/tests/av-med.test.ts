import assert from "node:assert/strict";
import test from "node:test";
import { avMedPayer } from "../index";

test("AV Med is configured for Waystar payer 59274 and service type 98", () => {
  assert.equal(avMedPayer.portalPayerName, "AvMed (59274)");
  assert.equal(avMedPayer.serviceTypeCode, "98");
  assert.equal(avMedPayer.patientLookupCode, "10");

  const result = avMedPayer.parseResult({
    overallStatus: "Active Coverage",
    healthBenefitPlanCoverage: { planType: "HMO" },
  }, { originalIndex: 2, raw: {} });
  assert.equal(result.payerId, "av-med");
  assert.equal(result.coverageStatus, "active");
});
test("AV Med uses Plan Sponsor as Plan Type and Plan Begin Date as Eff Date", () => {
  const result = avMedPayer.parseResult({
    healthBenefitPlanCoverage: {
      planSponsor: "INDIVIDUAL AVMED ENTRUST EXPANDED BRONZE STANDARD",
      benefitBeginDate: "01/01/2026",
      planType: "HMO",
      eligibilityBeginDate: "02/01/2026",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.planType, "INDIVIDUAL AVMED ENTRUST EXPANDED BRONZE STANDARD");
  assert.equal(result.effectiveDate, "01/01/2026");
});

test("AV Med tolerates missing Plan Sponsor and Plan Begin Date", () => {
  const result = avMedPayer.parseResult({
    healthBenefitPlanCoverage: {
      planType: "HMO",
      eligibilityBeginDate: "02/01/2026",
    },
  }, { originalIndex: 2, raw: {} });

  assert.equal(result.planType, "HMO");
  assert.equal(result.effectiveDate, "02/01/2026");
});