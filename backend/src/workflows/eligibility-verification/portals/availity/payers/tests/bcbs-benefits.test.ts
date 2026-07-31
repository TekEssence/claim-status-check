import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAvailityDob, parseAvailityBcbsBenefits } from "../bcbs/workflow";

test("reads Individual calendar-year and remaining values and ignores family/YTD", () => {
  const result = parseAvailityBcbsBenefits(`
    Health Benefit Plan Coverage - 30
    Annual Deductible
    $350 / Calendar Year(s)
    -$350 Year to Date
    $0 Remaining
    $700 / Calendar Year(s)
    $350 Remaining
    Out Of Pocket
    $6,000 / Calendar Year(s)
    -$6,000 Year to Date
    $0 Remaining
    $12,000 / Calendar Year(s)
    $5,844.98 Remaining
    Professional (Physician) Visit - Office - 98
    Coverage Level: Individual
    PREFERRED SPECIALIST
    —
    $40 / Visit(s)
    Coverage Level: Family
    50%
    $80 / Visit(s)
  `, "R123");
  assert.deepEqual(result, {
    coinsurance: "",
    copay: "$40",
    deductible: "$350",
    deductibleMet: "$0",
    outOfPocket: "$6,000",
    outOfPocketMet: "$0",
  });
});

test("prioritizes an Individual specialist block for coinsurance and copay", () => {
  const result = parseAvailityBcbsBenefits(`
    Health Benefit Plan Coverage - 30
    Annual Deductible $300 / Calendar Year(s) $150 Year to Date $150 Remaining
    Out Of Pocket $3,000 / Calendar Year(s) $1,500 Year to Date $1,500 Remaining
    Professional (Physician) Visit - Office - 98
    Coverage Level: Individual
    OFFICE VISIT - PROFESSIONAL
    0% / Visit(s)
    $20 / Visit(s)
    Coverage Level: Individual
    SPECIALIST
    10% / Visit(s)
    $40 / Visit(s)
  `, "ABC123");
  assert.equal(result.coinsurance, "10%");
  assert.equal(result.copay, "$40");
  assert.equal(result.deductible, "$300");
  assert.equal(result.deductibleMet, "$150");
  assert.equal(result.outOfPocket, "$3,000");
  assert.equal(result.outOfPocketMet, "$1,500");
});
test("normalizes and validates Availity DOB values", () => {
  assert.equal(normalizeAvailityDob("2/9/1980").formatted, "02/09/1980");
  assert.equal(normalizeAvailityDob("5/15/59").formatted, "05/15/1959");
  assert.equal(normalizeAvailityDob("1980-02-09").formatted, "02/09/1980");
  assert.equal(normalizeAvailityDob("Feb 9, 1980").formatted, "02/09/1980");
  assert.throws(() => normalizeAvailityDob("02/30/1980"), /Invalid DOB/);
});