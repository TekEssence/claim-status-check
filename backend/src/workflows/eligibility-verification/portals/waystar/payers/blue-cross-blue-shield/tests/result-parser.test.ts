import assert from "node:assert/strict";
import test from "node:test";
import { parseBlueCrossBlueShieldResult, selectProfessionalOfficeBenefits } from "..";

test("parses inactive Health Benefit Plan Coverage values", () => {
  const result = parseBlueCrossBlueShieldResult(
    {
      healthBenefitPlanCoverage: {
        planType: "Preferred Provider Organization (PPO)",
        planStatus: "INACTIVE",
        coverageDescription: "PREFERRED PROVIDER OPTION MEDICAL",
        eligibilityBeginDate: "03/01/2023",
        eligibilityEndDate: "04/30/2024",
      },
    },
    {
      originalIndex: 2,
      raw: {},
    },
    "blue-cross-blue-shield-texas",
  );

  assert.equal(result.coverageStatus, "inactive");
  assert.equal(result.planType, "PPO");
  assert.equal(result.planName, "PREFERRED PROVIDER OPTION MEDICAL");
  assert.equal(result.planStatus, "INACTIVE");
  assert.equal(result.effectiveDate, "03/01/2023");
  assert.equal(result.terminationDate, "04/30/2024");
  assert.deepEqual(result.benefits, [
    {
      serviceType: "30 - Health Benefit Plan Coverage",
      coverageStatus: "inactive",
      notes: "INACTIVE",
    },
  ]);
});

test("extracts BCBS active subscriber and coverage fields", () => {
  const result = parseBlueCrossBlueShieldResult({
    subscriberInformation: {
      patientName: "Jane Doe",
      address: "1 Main St, Austin, TX",
      memberId: "ABC123",
      dateOfBirth: "01/02/1980",
      sex: "Female",
    },
    subscriberCoverageInformation: {
      groupNumber: "G100",
      planDate: "01/01/2026 - 12/31/2026",
      premiumPaidToDateEnd: "07/31/2026",
      insuranceType: "HMO",
    },
    general: { primaryCareProvider: "Dr Smith" },
    healthBenefitPlanCoverage: {
      planType: "Health Maintenance Organization (HMO)",
      planStatus: "ACTIVE",
      coverageDescription: "incorrect fallback",
      general: { coverageDescription: "BLUE ADVANTAGE PLUS MEDICAL" },
    },
  }, { originalIndex: 3, raw: {} }, "blue-cross-blue-shield-texas");

  assert.equal(result.patientName, "Jane Doe");
  assert.equal(result.memberId, "ABC123");
  assert.equal(result.groupNumber, "G100");
  assert.equal(result.planDate, "01/01/2026 - 12/31/2026");
  assert.equal(result.premiumPaidEndDate, "07/31/2026");
  assert.equal(result.insuranceType, "HMO");
  assert.equal(result.primaryCareProvider, "Dr Smith");
  assert.equal(result.coverageDescription, "BLUE ADVANTAGE PLUS MEDICAL");
});

test("uses the available Waystar sections when Health Benefit Plan Coverage is absent", () => {
  const result = parseBlueCrossBlueShieldResult({
    overallStatus: "ACTIVE",
    sectionStatuses: [
      { title: "Professional Office Visit", status: "ACTIVE" },
      { title: "Chiropractic", status: "ACTIVE" },
    ],
  }, { originalIndex: 4, raw: {} }, "blue-cross-blue-shield-texas");

  assert.equal(result.coverageStatus, "active");
  assert.equal(result.planStatus, "ACTIVE");
  assert.equal(result.planName, "Professional Office Visit, Chiropractic");
  assert.deepEqual(result.benefits, [
    {
      serviceType: "Professional Office Visit",
      coverageStatus: "active",
      notes: "ACTIVE",
    },
    {
      serviceType: "Chiropractic",
      coverageStatus: "active",
      notes: "ACTIVE",
    },
  ]);
});

test("selects highest office coinsurance and specialty-qualified copay from Individual Coverage", () => {
  const result = selectProfessionalOfficeBenefits([
    {
      network: "Out of Network",
      coverageLevel: "Family Coverage",
      entries: [{ type: "Co Insurance", value: "100%", placeOfService: "Office" }],
    },
    {
      network: "Out of Network",
      coverageLevel: "Individual Coverage",
      entries: [
        { type: "Co Insurance", value: "0%", placeOfService: "Office" },
        { type: "Co Insurance", value: "50%", placeOfService: "Office" },
        { type: "Co Insurance", value: "100%", placeOfService: "Office" },
        { type: "Co Insurance", value: "200%", placeOfService: "Unknown" },
        { type: "Copay", value: "$20", includedProviderSpecialties: "Primary Care" },
        { type: "Copay", value: "$50", includedProviderSpecialties: "Specialist" },
        { type: "Copay", value: "$90", includedProviderSpecialties: "Unknown" },
      ],
    },
  ]);

  assert.equal(result.inOutNetwork, "OON");
  assert.equal(result.coinsurance, "100%");
  assert.equal(result.copay, "$50");
});

test("calculates deductible met and OOP met using office calendar-year and remaining values", () => {
  const result = selectProfessionalOfficeBenefits([{
    network: "In Network",
    coverageLevel: "Individual Coverage",
    entries: [
      { type: "Deductible", value: "$100 Calendar Year", placeOfService: "Office" },
      { type: "Deductible", value: "$50 Remaining", placeOfService: "Office" },
      { type: "Deductible", value: "$500 Calendar Year", placeOfService: "Unknown" },
      { type: "Out of Pocket", value: "$2,000", period: "Calendar Year", placeOfService: "Office" },
      { type: "Out of Pocket", value: "$750", period: "Remaining", placeOfService: "Office" },
    ],
  }]);

  assert.equal(result.inOutNetwork, "INN");
  assert.equal(result.deductible, "$100");
  assert.equal(result.deductibleMet, "$50");
  assert.equal(result.outOfPocket, "$2,000");
  assert.equal(result.outOfPocketMet, "$1,250");
});

test("prefers In Network when professional office contains both networks", () => {
  const result = selectProfessionalOfficeBenefits([
    {
      network: "Out of Network",
      coverageLevel: "Individual Coverage",
      entries: [{ type: "Co-Insurance", value: "80%", placeOfService: "Office" }],
    },
    {
      network: "In Network",
      coverageLevel: "Individual Coverage",
      entries: [
        { type: "Co-Insurance", value: "20%", placeOfService: "Office" },
        { type: "Co-Payment", value: "$35.00 Visit", payerNote: "SPECIALIST" },
      ],
    },
  ]);

  assert.equal(result.inOutNetwork, "INN");
  assert.equal(result.coinsurance, "20%");
  assert.equal(result.copay, "$35");
});

test("uses only OON when it is the sole professional office network", () => {
  const result = selectProfessionalOfficeBenefits([{
    network: "Out of Network",
    coverageLevel: "Individual Coverage",
    entries: [{ type: "Coinsurance", value: "40%", placeOfService: "Office" }],
  }]);

  assert.equal(result.inOutNetwork, "OON");
  assert.equal(result.coinsurance, "40%");
});

test("falls back to In Network Health Benefit Plan Coverage deductible and OOP", () => {
  const result = selectProfessionalOfficeBenefits(
    [{
      network: "In Network",
      coverageLevel: "Individual Coverage",
      entries: [{ type: "Co-Insurance", value: "20%", placeOfService: "Office" }],
    }],
    [
      {
        network: "Out of Network",
        coverageLevel: "Individual Coverage",
        entries: [
          { type: "Deductible", value: "$9,000", period: "Calendar Year" },
          { type: "Deductible", value: "$8,000", period: "Remaining" },
        ],
      },
      {
        network: "In Network",
        coverageLevel: "Individual Coverage",
        entries: [
          { type: "Deductible", value: "$1,000", period: "Calendar Year" },
          { type: "Deductible", value: "$400", period: "Remaining" },
          { type: "Out of Pocket", value: "$5,000", period: "Calendar Year" },
          { type: "Out of Pocket", value: "$1,500", period: "Remaining" },
        ],
      },
    ],
  );

  assert.equal(result.deductible, "$1,000");
  assert.equal(result.deductibleMet, "$600");
  assert.equal(result.outOfPocket, "$5,000");
  assert.equal(result.outOfPocketMet, "$3,500");
});
