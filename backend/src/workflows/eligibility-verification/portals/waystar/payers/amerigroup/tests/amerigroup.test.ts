import assert from "node:assert/strict";
import test from "node:test";
import { amerigroupWellpointPayer } from "..";

test("extracts Amerigroup IPA while omitting duplicate subscriber identity fields", () => {
  const result = amerigroupWellpointPayer.parseResult({
    overallStatus: "ACTIVE",
    subscriberInformation: {
      patientName: "Jane Doe",
      memberId: "MEM-100",
      dateOfBirth: "01/02/1980",
      sex: "Female",
    },
    general: {
      ipa: "VAN LANG",
    },
    healthBenefitPlanCoverage: {
      planStatus: "ACTIVE",
      coverageDescription: "Amerigroup Coverage",
    },
  }, {
    originalIndex: 2,
    memberId: "MEM-100",
    patientFirstName: "Jane",
    patientLastName: "Doe",
    dateOfBirth: "01/02/1980",
    raw: {},
  });

  assert.equal(result.payerId, "amerigroup-wellpoint");
  assert.equal(result.ipa, "VAN LANG");
  assert.equal(result.patientName, undefined);
  assert.equal(result.memberId, undefined);
  assert.equal(result.dateOfBirth, undefined);
  assert.equal(result.sex, undefined);
  assert.equal(result.coverageStatus, "active");
});