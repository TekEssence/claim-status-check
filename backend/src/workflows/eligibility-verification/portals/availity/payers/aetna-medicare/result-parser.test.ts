import assert from "node:assert/strict";
import test from "node:test";
import { parseAetnaResultOverrides } from "./result-parser";

test("extracts Aetna eligibility begin date and Specialist Visit copay", () => {
  const result = parseAetnaResultOverrides(`
    Eligibility Begin Date: Oct 1, 2025
    Benefit description: Specialist Visit or Evaluation
    Coverage Level: Employee Only
    GYN Visit, COPAY INCLUDED IN OOP ? $25
    Specialist Visit or Evaluation, COPAY INCLUDED IN OOP ? $75
  `);
  assert.equal(result.effectiveDate, "Oct 1, 2025");
  assert.equal(result.coinsurance, "-");
  assert.equal(result.copay, "$75");
});

test("extracts an Aetna row labeled Specialist only", () => {
  const result = parseAetnaResultOverrides(`
    Coverage Level: Employee Only
    Specialist - $60
  `);
  assert.equal(result.coinsurance, "-");
  assert.equal(result.copay, "$60");
});

test("skips an unrelated specialist mention without cost sharing", () => {
  const result = parseAetnaResultOverrides(`
    Telemedicine Specialist Visit/Plan Ded Waived
    Place of Service: Office
    Specialist - $75
  `);
  assert.equal(result.coinsurance, "-");
  assert.equal(result.copay, "$75");
});
