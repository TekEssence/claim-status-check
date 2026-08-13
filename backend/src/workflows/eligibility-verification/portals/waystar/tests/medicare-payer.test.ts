import assert from "node:assert/strict";
import test from "node:test";
import { medicarePayer } from "../payers/medicare";

const sampleRow = {
  originalIndex: 4,
  memberId: "12345",
  patientFirstName: "John",
  patientLastName: "Doe",
  dateOfBirth: "01/01/1950",
  raw: {},
};

test("Waystar Medicare parser reads flattened other coverage service type and deductible table", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "Active Coverage",
      sectionStatuses: [
        {
          title: "Medicare Part B",
          status: "Active Coverage",
          detailsText: [
            "Plan Date",
            "01/01/2026 to 12/31/2026",
            "Payer Note",
            "0-BENEFICIARY INSURED DUE TO AGE OASI",
            "Co-Insurance",
            "20.0% Visit",
          ].join("\n"),
        },
      ],
      bodyText: [
        "OTHER COVERAGE INFORMATION",
        "Medicare Prescription Drug Coverage",
        "Payer",
        "MEDCO CONTAINMENT LIFE & MEDCO CONTAINMENT NY & HE",
        "Address",
        "1001 E. LOOKOUT DRIVE",
        "Status",
        "Payer",
        "Phone",
        "(877) 895-6448",
        "URL",
        "WWW.HCSC.COM",
        "Insurance Type",
        "Other Insurance - OT",
        "Benefit Date",
        "01/01/2011",
        "Plan Number",
        "S5715",
        "Plan Network ID Number",
        "005",
        "Service Type",
        "Pharmacy",
        "Plan Sponsor",
        "BLUE CROSS MEDICARERX VALUE",
        "Deductible Remaining",
        "The patient has a remaining deductible that is at or above alert limits set by your organization.",
        "Payer",
        "CMS",
        "Medicare A",
        "Medicare B",
        "Yearly Deductible",
        "$1,736",
        "$283",
        "Deductible Remaining",
        "$1,736",
        "$0",
      ].join("\n"),
    },
    sampleRow,
  );

  const portalFields = (result.metadata?.portalFields ?? {}) as Record<string, unknown>;
  assert.equal(portalFields.serviceType, "Pharmacy");
  assert.equal(portalFields.deductible, 283);
  assert.equal(portalFields.deductibleRemaining, 0);
  assert.equal(portalFields.deductibleMet, 283);
});

test("Waystar Medicare parser reads Medicare B deductible values from a flattened deductible table", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "Active Coverage",
      sectionStatuses: [
        {
          title: "Other Coverage",
          status: "Active Coverage",
          detailsText: [
            "Service Type",
            "Health Benefit Plan Coverage",
          ].join("\n"),
        },
        {
          title: "Medicare Part B",
          status: "Active Coverage",
          detailsText: [
            "Plan Date",
            "01/01/2026 to 12/31/2026",
            "Payer Note",
            "0-BENEFICIARY INSURED DUE TO AGE OASI",
            "Co-Insurance",
            "20.0% Visit",
          ].join("\n"),
        },
      ],
      bodyText: "Other Coverage Active Coverage Service Type Health Benefit Plan Coverage Medicare Part B Active Coverage Payer CMS Medicare A Medicare B Yearly Deductible $1,736 $283 Deductible Remaining $1,736 $0",
    },
    sampleRow,
  );

  const portalFields = (result.metadata?.portalFields ?? {}) as Record<string, unknown>;
  assert.equal(portalFields.serviceType, "Health Benefit Plan Coverage");
  assert.equal(portalFields.deductible, 283);
  assert.equal(portalFields.deductibleRemaining, 0);
  assert.equal(portalFields.deductibleMet, 283);
});

test("Waystar Medicare parser uses other coverage service type and Medicare B deductible summary", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "Active Coverage",
      bodyText: [
        "OTHER COVERAGE",
        "ACTIVE COVERAGE",
        "Service Type",
        "Pharmacy",
        "MEDICARE PART B",
        "ACTIVE COVERAGE",
        "General",
        "Medicare Part B",
        "Plan Date",
        "03/01/2008",
        "Payer Note",
        "0-BENEFICIARY INSURED DUE TO AGE OASI",
        "Service Type",
        "Health Benefit Plan Coverage",
        "Deductible",
        "$283.00 Calendar Year",
        "Plan Date",
        "01/01/2026 to 12/31/2026",
        "Service Type",
        "Health Benefit Plan Coverage",
        "Deductible",
        "$0.00 Remaining",
        "Plan Date",
        "01/01/2026 to 12/31/2026",
        "Service Type",
        "Health Benefit Plan Coverage",
        "Co-Insurance",
        "20.0% Visit",
        "Payer",
        "CMS",
        "Medicare A",
        "Medicare B",
        "Yearly Deductible",
        "$1,736",
        "$283",
        "Deductible Remaining",
        "$1,736",
        "$0",
      ].join("\n"),
      sectionStatuses: [
        {
          title: "Other Coverage",
          status: "Active Coverage",
          detailsText: [
            "Service Type",
            "Pharmacy",
            "Plan Sponsor",
            "BLUE CROSS MEDICARERX VALUE",
          ].join("\n"),
        },
        {
          title: "Medicare Part B",
          status: "Active Coverage",
          detailsText: [
            "General",
            "Medicare Part B",
            "Plan Date",
            "03/01/2008",
            "Payer Note",
            "0-BENEFICIARY INSURED DUE TO AGE OASI",
            "Service Type",
            "Health Benefit Plan Coverage",
            "Deductible",
            "$283.00 Calendar Year",
            "Plan Date",
            "01/01/2026 to 12/31/2026",
            "Service Type",
            "Health Benefit Plan Coverage",
            "Deductible",
            "$0.00 Remaining",
            "Plan Date",
            "01/01/2026 to 12/31/2026",
            "Service Type",
            "Health Benefit Plan Coverage",
            "Co-Insurance",
            "20.0% Visit",
          ].join("\n"),
        },
      ],
    },
    sampleRow,
  );

  const portalFields = (result.metadata?.portalFields ?? {}) as Record<string, unknown>;
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.planName, "Other Coverage");
  assert.equal(result.planStatus, "Active Coverage");
  assert.equal(portalFields.planDate, undefined);
  assert.equal(portalFields.payerNote, undefined);
  assert.equal(portalFields.serviceType, "Pharmacy");
  assert.equal(portalFields.deductible, undefined);
  assert.equal(portalFields.deductibleRemaining, undefined);
  assert.equal(portalFields.deductibleMet, undefined);
  assert.equal(result.benefits[0]?.serviceType, "Pharmacy");
});

test("Waystar Medicare parser uses top plan date above payer note and Medicare B deductible summary", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "Active Coverage",
      bodyText: [
        "OTHER COVERAGE",
        "ACTIVE COVERAGE",
        "Service Type",
        "Health Benefit Plan Coverage",
        "MEDICARE PART B",
        "ACTIVE COVERAGE",
        "General",
        "Medicare Part B",
        "Plan Date",
        "03/01/2008",
        "Payer Note",
        "0-BENEFICIARY INSURED DUE TO AGE OASI",
        "Service Type",
        "Health Benefit Plan Coverage",
        "Deductible",
        "$283.00 Calendar Year",
        "Plan Date",
        "01/01/2026 to 12/31/2026",
        "Service Type",
        "Health Benefit Plan Coverage",
        "Deductible",
        "$0.00 Remaining",
        "Plan Date",
        "01/01/2026 to 12/31/2026",
        "Service Type",
        "Health Benefit Plan Coverage",
        "Co-Insurance",
        "20.0% Visit",
        "Payer",
        "CMS",
        "Medicare A",
        "Medicare B",
        "Yearly Deductible",
        "$1,736",
        "$283",
        "Deductible Remaining",
        "$1,736",
        "$0",
      ].join("\n"),
      sectionStatuses: [
        {
          title: "Other Coverage",
          status: "Active Coverage",
          detailsText: [
            "Service Type",
            "Health Benefit Plan Coverage",
          ].join("\n"),
        },
        {
          title: "Medicare Part B",
          status: "Active Coverage",
          detailsText: [
            "General",
            "Medicare Part B",
            "Plan Date",
            "03/01/2008",
            "Payer Note",
            "0-BENEFICIARY INSURED DUE TO AGE OASI",
            "Service Type",
            "Health Benefit Plan Coverage",
            "Deductible",
            "$283.00 Calendar Year",
            "Plan Date",
            "01/01/2026 to 12/31/2026",
            "Service Type",
            "Health Benefit Plan Coverage",
            "Deductible",
            "$0.00 Remaining",
            "Plan Date",
            "01/01/2026 to 12/31/2026",
            "Service Type",
            "Health Benefit Plan Coverage",
            "Co-Insurance",
            "20.0% Visit",
          ].join("\n"),
        },
      ],
    },
    sampleRow,
  );

  const portalFields = (result.metadata?.portalFields ?? {}) as Record<string, unknown>;
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.planName, "Medicare Part B");
  assert.equal(result.planStatus, "Active Coverage");
  assert.equal(portalFields.planDate, "03/01/2008");
  assert.equal(portalFields.payerNote, "0-BENEFICIARY INSURED DUE TO AGE OASI");
  assert.equal(portalFields.serviceType, "Health Benefit Plan Coverage");
  assert.equal(portalFields.deductible, 283);
  assert.equal(portalFields.deductibleRemaining, 0);
  assert.equal(portalFields.deductibleMet, 283);
  assert.equal(portalFields.coInsurance, "20.0% Visit");
});

test("Waystar Medicare parser stops extraction when service type is Pharmacy", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "Active Coverage",
      sectionStatuses: [
        {
          title: "Other Coverage",
          status: "Active Coverage",
          detailsText: [
            "Service Type",
            "Pharmacy",
            "Plan Sponsor",
            "BLUE CROSS MEDICARERX VALUE",
          ].join("\n"),
        },
        {
          title: "Medicare Part B",
          status: "Active Coverage",
          detailsText: [
            "Plan Date",
            "03/01/2008",
            "Deductible",
            "$283.00 Calendar Year",
          ].join("\n"),
        },
      ],
      bodyText: "Other Coverage Active Coverage Service Type Pharmacy Medicare Part B Active Coverage",
    },
    sampleRow,
  );

  const portalFields = (result.metadata?.portalFields ?? {}) as Record<string, unknown>;
  assert.equal(result.planStatus, "Active Coverage");
  assert.equal(portalFields.serviceType, "Pharmacy");
  assert.equal(portalFields.planDate, undefined);
  assert.equal(portalFields.deductible, undefined);
  assert.equal(portalFields.deductibleRemaining, undefined);
  assert.equal(portalFields.deductibleMet, undefined);
  assert.equal(result.benefits[0]?.serviceType, "Pharmacy");
});

test("Waystar Medicare parser falls back to body text when structured statuses are missing", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "",
      sectionStatuses: [],
      bodyText: [
        "Other Coverage",
        "Active Coverage",
        "Service Type",
        "Health Benefit Plan Coverage",
        "Medicare Part B",
        "Active Coverage",
        "Plan Date",
        "01/01/2026 to 12/31/2026",
        "Payer",
        "CMS",
        "Medicare A",
        "Medicare B",
        "Yearly Deductible",
        "$1,736",
        "$283",
        "Deductible Remaining",
        "$1,736",
        "$0",
      ].join("\n"),
    },
    sampleRow,
  );

  assert.equal(result.coverageStatus, "active");
  assert.equal(result.planName, "Medicare Part B");
  assert.equal((result.metadata?.portalFields as Record<string, unknown>).serviceType, "Health Benefit Plan Coverage");
});

test("Waystar Medicare parser classifies inactive before active substring matches", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "Inactive Coverage",
      sectionStatuses: [],
      bodyText: "Medicare Part A Inactive Coverage",
    },
    sampleRow,
  );

  assert.equal(result.coverageStatus, "inactive");
  assert.equal(result.benefits[0]?.coverageStatus, "inactive");
});
