import assert from "node:assert/strict";
import test from "node:test";
import { medicarePayer } from "../payers/medicare";

test("Waystar Medicare parser marks active coverage and benefit rows", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "Active Coverage",
      sectionStatuses: [
        { title: "Medicare Part B", status: "Active Coverage" },
      ],
      subscriberCoverageInformation: {
        insuranceType: "Medicare",
      },
      patientInformation: {
        relationshipToSubscriber: "Self",
      },
      healthBenefitPlanCoverage: {
        planType: "Medicare Part B",
        eligibilityBeginDate: "01/01/2026",
        planStatus: "Active Coverage",
      },
    },
    {
      originalIndex: 4,
      memberId: "12345",
      patientFirstName: "John",
      patientLastName: "Doe",
      dateOfBirth: "01/01/1950",
      raw: {},
    },
  );

  assert.equal(result.rowIndex, 4);
  assert.equal(result.payerId, "medicare");
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.planType, "Medicare Part B");
  assert.equal(result.effectiveDate, "01/01/2026");
  assert.equal(result.insuranceType, "Medicare");
  assert.equal(result.relationshipToSubscriber, "Self");
  assert.equal(result.benefits.length, 1);
  assert.equal(result.benefits[0]?.serviceType, "30 - Health Benefit Plan Coverage");
  assert.equal(result.benefits[0]?.coverageStatus, "active");
});
