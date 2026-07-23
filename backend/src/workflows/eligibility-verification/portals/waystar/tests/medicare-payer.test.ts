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

test("Waystar Medicare parser marks active coverage and benefit rows", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "Active Coverage",
      sectionStatuses: [
        { title: "Medicare Part B", status: "Active Coverage" },
      ],
    },
    sampleRow,
  );

  assert.equal(result.rowIndex, 4);
  assert.equal(result.payerId, "medicare");
  assert.equal(result.coverageStatus, "active");
  assert.equal(result.planName, "Medicare Part B");
  assert.equal(result.benefits.length, 1);
  assert.equal(result.benefits[0]?.serviceType, "Medicare Part B");
  assert.equal(result.benefits[0]?.coverageStatus, "active");
});

test("Waystar Medicare parser falls back to body text when structured statuses are missing", () => {
  const result = medicarePayer.parseResult(
    {
      overallStatus: "",
      sectionStatuses: [],
      bodyText: "Health Benefit Plan Coverage Medicare Part B Active Coverage Subscriber Information",
    },
    sampleRow,
  );

  assert.equal(result.coverageStatus, "active");
  assert.equal(result.planName, "Medicare Part B");
  assert.equal(result.benefits[0]?.serviceType, "Medicare Part B");
  assert.equal(result.benefits[0]?.coverageStatus, "active");
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
