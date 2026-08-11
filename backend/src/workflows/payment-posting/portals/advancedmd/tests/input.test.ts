import assert from "node:assert/strict";
import test from "node:test";
import { mapInputRow } from "../input";

test("maps supported Excel header aliases", () => {
  const row = mapInputRow({
    "Patient Name": "Jane Doe",
    "Patient ID": "0007",
    "Patient Control Number": "PCN-1",
    "Check #": "123456",
    "Deposit Date": "01/02/2026",
    "Payer Name": "Aetna Parent",
    Carrier: "Aetna",
    "Check Amount": "$100.00",
    DOS: "01/01/2026",
    CPT: "99213",
    Charge: "120",
    "Insurance Allowed": "100",
    Payment: "80",
    Adjustment: "20",
    "Denial Code": "PR-3",
    "Denial Reason": "Copay",
    "Remark Code": "N479",
    "Remark Reason": "Missing EOB",
  }, 12);

  assert.equal(row.inputRow, 12);
  assert.equal(row.checkNumber, "123456");
  assert.equal(row.payerName, "Aetna Parent");
  assert.equal(row.carrier, "Aetna");
  assert.equal(row.patientId, "0007");
  assert.equal(row.patientControlNumber, "PCN-1");
  assert.equal(row.visitClaimNumber, "");
  assert.equal(row.cpt, "99213");
  assert.equal(row.denialCode, "PR-3");
  assert.deepEqual(row.validationErrors, []);
});

test("records strict validation errors per invalid row", () => {
  const row = mapInputRow({
    "Check #": "",
    "Payer Name": "Aetna",
  }, 2);

  assert.ok(row.validationErrors.includes("Check # is required."));
  assert.ok(row.validationErrors.includes("Carrier is required."));
  assert.ok(row.validationErrors.includes("Patient ID is required."));
  assert.ok(row.validationErrors.includes("Payment is required."));
  assert.ok(!row.validationErrors.includes("Visit/Claim # is required."));
});
