import assert from "node:assert/strict";
import test from "node:test";
import { applyMedRevenueBlueCrossResultMappings, applyMedRevenueMedicareResultMappings } from "../scraper";
import type { EligibilityResult } from "../../../types";

test("maps MedRevenue Medicare response fields without changing shared parser fields", () => {
  const result: EligibilityResult = {
    rowIndex: 2,
    payerId: "medicare",
    coverageStatus: "active",
    planStatus: "Active Coverage",
    planDate: "09/04/2026 to 09/04/2026",
    benefits: [],
    metadata: {
      fullPayerResponse: {
        subscriberCoverageInformation: {
          fields: { "Eligibility Date": "01/01/2026 to 12/31/2026" },
        },
        medicarePartBCoverage: {
          title: "Medicare Part B",
          status: "ACTIVE COVERAGE",
          rows: [
            { label: "Effective Date", value: "09/01/2014" },
            { label: "Termination Date", value: "" },
          ],
        },
        medicareDateOfDeath: "02/01/2025",
        otherCoverageInformation: [{
          title: "Other Coverage Information",
          groups: [{
            title: "Medicare Prescription Drug Coverage",
            rows: [
              { label: "Payer", value: "WELLCARE PRESCRIPTION INSURANCE, INC." },
              { label: "Benefit Date", value: "01/01/2023" },
              { label: "Service Type", value: "Pharmacy" },
            ],
          }],
        }],
        sections: [{
          title: "Alcoholism",
          status: "Active Coverage",
          groups: [{
            title: "General",
            rows: [
              { label: "Coverage Description", value: "Medicare Part B" },
              { label: "Plan Date", value: "05/01/2019" },
              { label: "Payer Note", value: "0-BENEFICIARY INSURED DUE TO AGE OASI" },
            ],
          }],
        }],
      },
    },
  };

  const mapped = applyMedRevenueMedicareResultMappings(result);
  assert.equal(mapped.coverageStatus, "active");
  assert.equal(mapped.planStatus, "ACTIVE COVERAGE");
  assert.equal(mapped.planDate, "05/01/2019");
  assert.equal(mapped.effectiveDate, "09/01/2014");
  assert.equal(mapped.terminationDate, undefined);
  assert.equal(mapped.otherInsurance, "WELLCARE PRESCRIPTION INSURANCE, INC.");
  assert.equal(mapped.otherInsuranceEffectiveDate, "01/01/2023");
  assert.equal(mapped.metadata?.medRevenueMedicarePartBStatus, "ACTIVE COVERAGE");
  assert.equal(mapped.metadata?.medRevenueMedicareDateOfDeathStatus, "Dead");
  assert.equal(mapped.metadata?.medRevenueMedicareDateOfDeath, "02/01/2025");
  assert.equal(mapped.metadata?.medRevenuePrescriptionDrugServiceType, "Pharmacy");
});

test("maps MedRevenue Medicare Part B termination date when present", () => {
  const result: EligibilityResult = {
    rowIndex: 2,
    payerId: "medicare",
    coverageStatus: "active",
    effectiveDate: "01/01/2026",
    terminationDate: undefined,
    benefits: [],
    metadata: {
      fullPayerResponse: {
        medicarePartBCoverage: {
          title: "Medicare Part B",
          status: "ACTIVE COVERAGE",
          rows: [
            { label: "Effective Date", value: "09/01/2014" },
            { label: "Termination Date", value: "12/31/2026" },
          ],
        },
      },
    },
  };

  const mapped = applyMedRevenueMedicareResultMappings(result);
  assert.equal(mapped.effectiveDate, "09/01/2014");
  assert.equal(mapped.terminationDate, "12/31/2026");
  assert.equal(mapped.metadata?.medRevenueMedicareDateOfDeathStatus, "-");
});

test("does not mark MedRevenue Medicare Date of Death dead for non-date text", () => {
  const result: EligibilityResult = {
    rowIndex: 2,
    payerId: "medicare",
    coverageStatus: "active",
    benefits: [],
    metadata: {
      fullPayerResponse: {
        medicareDateOfDeath: "",
      },
    },
  };

  const mapped = applyMedRevenueMedicareResultMappings(result);
  assert.equal(mapped.metadata?.medRevenueMedicareDateOfDeathStatus, "-");
});

test("maps MedRevenue Blue Cross secondary coverage fields from its own card", () => {
  const result: EligibilityResult = {
    rowIndex: 2,
    payerId: "bcbs-ppo",
    coverageStatus: "active",
    benefits: [],
    metadata: {
      fullPayerResponse: {
        secondaryCoverageInformation: {
          title: "SECONDARY BLUE ON BLUE INTRA",
          rows: [
            { label: "Coverage Description", value: "SECONDARY BLUE ON BLUE INTRA" },
            { label: "COB Date", value: "04/02/2019" },
            { label: "Group or Policy Number", value: "KZU27119127E" },
            { label: "Service Type", value: "Health Benefit Plan Coverage" },
          ],
        },
      },
    },
  };

  const mapped = applyMedRevenueBlueCrossResultMappings(result);
  assert.equal(mapped.metadata?.medRevenueSecondaryCoverageDescription, "SECONDARY BLUE ON BLUE INTRA");
  assert.equal(mapped.metadata?.medRevenueSecondaryCobDate, "04/02/2019");
  assert.equal(mapped.metadata?.medRevenueSecondaryGroupOrPolicyNumber, "KZU27119127E");
  assert.equal(mapped.metadata?.medRevenueSecondaryServiceType, "Health Benefit Plan Coverage");
  assert.equal(mapped.metadata?.medRevenueOutputServiceType, "Health Benefit Plan Coverage");
});
