import assert from "node:assert/strict";
import test from "node:test";
import { applyMedRevenueMedicareResultMappings } from "../scraper";
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
      },
    },
  };

  const mapped = applyMedRevenueMedicareResultMappings(result);
  assert.equal(mapped.coverageStatus, "active");
  assert.equal(mapped.planStatus, "Active Coverage");
  assert.equal(mapped.planDate, "09/04/2026 to 09/04/2026");
  assert.equal(mapped.effectiveDate, "01/01/2026 to 12/31/2026");
  assert.equal(mapped.terminationDate, undefined);
  assert.equal(mapped.otherInsurance, "WELLCARE PRESCRIPTION INSURANCE, INC.");
  assert.equal(mapped.otherInsuranceEffectiveDate, "01/01/2023");
  assert.equal(mapped.metadata?.medRevenuePrescriptionDrugServiceType, "Pharmacy");
});
