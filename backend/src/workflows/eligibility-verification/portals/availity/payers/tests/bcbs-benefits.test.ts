import assert from "node:assert/strict";
import test from "node:test";
import { extractAvailityPortalError, normalizeAvailityDob, parseAvailityBcbsBenefits, parseAvailitySnapshotBasics } from "../bcbs/workflow";

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
    â€”
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
test("extracts row 3 professional values and Individual Out of Pocket when headings precede coverage", () => {
  const result = parseAvailityBcbsBenefits(`
    Health Benefit Plan Coverage - 30
    Out Of Pocket
    In Network
    Auth Info Unknown
    Place of Service: Office
    Coverage Level: Individual
    $7,396.99 Remaining, $8,300 / Calendar Year(s)
    OFFICE VISIT - PROFESSIONAL
    Coverage Level: Family
    $15,696.99 Remaining, $16,600 / Calendar Year(s)
    Professional (Physician) Visit - Office - 98
    Information / Details
    Co-Insurance
    Co-Payment
    In Network
    Place of Service: Office
    Coverage Level: Individual
    0% /
    Visit(s)
    $40 /
    Day(s)
    OFFICE VISIT - PROFESSIONAL
  `, "ABC123");
  assert.equal(result.coinsurance, "0%");
  assert.equal(result.copay, "$40");
  assert.equal(result.outOfPocket, "$8,300");
  assert.equal(result.outOfPocketMet, "$7,396.99");
});
test("extracts coinsurance and copay from the Individual SPECIALIST row", () => {
  const result = parseAvailityBcbsBenefits(`
    Professional (Physician) Visit - Office - 98
    SPECIALIST
    Information / Details
    Co-Insurance
    Co-Payment
    In Network
    Coverage Level: Individual
    20%
    $35 /
    Visit (s)
    SPECIALIST
    In Network
    Coverage Level: Individual
    —
    $35 / Visit(s)
    INCLUSIONS FAMILY
  `, "ABC123");
  assert.equal(result.coinsurance, "20%");
  assert.equal(result.copay, "$35");
});
test("selects the Preferred Specialist row for an R-prefixed member", () => {
  const result = parseAvailityBcbsBenefits(`
    Professional (Physician) Visit - Office - 98
    Information / Details
    Co-Insurance
    Co-Payment
    Preferred
    Plan / Product: STANDARD
    Coverage Level: Individual
    —
    $30 / Visit(s)
    PREFERRED PRIMARY CARE AND OTHER HEALTH CARE PROFESSIONAL;
    TELEMEDICINE EXCEPT WHEN PREVENTIVE
    Preferred
    Plan / Product: STANDARD
    Coverage Level: Individual
    —
    $40 / Visit(s)
    PREFERRED SPECIALIST; TELEMEDICINE EXCEPT WHEN PREVENTIVE
  `, "R123456");
  assert.equal(result.coinsurance, "");
  assert.equal(result.copay, "$40");
});
test("does not merge a year with a percentage", () => {
  const result = parseAvailityBcbsBenefits(`
    Professional (Physician) Visit - Office - 98
    Coverage Level: Individual
    SPECIALIST
    Coverage End Date: Dec 31, 2026100%
  `, "ABC123");
  assert.equal(result.coinsurance, "");
});
test("reads copay variants from the same Specialist block", () => {
  for (const copayText of ["$35/Visit(s)", "$35 per Visit", "$35 / Day (s)"]) {
    const result = parseAvailityBcbsBenefits(`
      Professional(Physician)Visit-Office-98
      CoverageLevel:Individual
      20%
      ${copayText}
      SPECIALIST
    `, "ABC123");
    assert.equal(result.coinsurance, "20%");
    assert.equal(result.copay, "$35");
  }
});
test("extracts consistent summary fields from one result snapshot", () => {
  const result = parseAvailitySnapshotBasics(`
    Member Status
    Active
    Current Plan Effective Date
    Oct 1, 2023 - Dec 31, 9999
    Relationship to Subscriber
    Self
    Insurance Type: Preferred Provider Organization (PPO)
    Plan / Product: BLUECARD PPO
  `);
  assert.equal(result.coverageStatus, "Active");
  assert.equal(result.effectiveDate, "Oct 1, 2023");
  assert.equal(result.endDate, "Dec 31, 9999");
  assert.equal(result.relationship, "Self");
  assert.equal(result.insuranceType, "Preferred Provider Organization (PPO)");
  assert.equal(result.planType, "BLUECARD PPO");
});
test("does not use an OOP progress percentage as professional coinsurance", () => {
  const result = parseAvailityBcbsBenefits(`
    Health Benefit Plan Coverage - 30
    Out Of Pocket
    Coverage Level: Individual
    17%
    $7,396.99 Remaining, $8,300 / Calendar Year(s)
    OFFICE VISIT - PROFESSIONAL
    Professional (Physician) Visit - Office - 98
    Coverage Level: Individual
    0%
    $40 / Visit(s)
    OFFICE VISIT - PROFESSIONAL
  `, "ABC123");
  assert.equal(result.coinsurance, "0%");
  assert.equal(result.copay, "$40");
});

test("uses the normal Individual professional row when Specialist is absent", () => {
  const result = parseAvailityBcbsBenefits(`
    Professional (Physician) Visit - Office - 98
    Coverage Level: Individual
    20%
    $35 / Visit(s)
    OFFICE VISIT - PROFESSIONAL
  `, "ABC123");
  assert.equal(result.coinsurance, "20%");
  assert.equal(result.copay, "$35");
});
test("recognizes an Availity health-plan connection error", () => {
  const error = extractAvailityPortalError(`
    Availity is experiencing connection problems with the health plan.
    Try your request again later. If the problem continues, contact Availity Client Services.
    Date of Service Aug 3, 2026
    Transaction ID 77248706231
    Transaction Time Aug 3, 1:51 AM
    Customer ID 978275
  `);
  assert.match(error, /connection problems with the health plan/i);
  assert.match(error, /Transaction ID: 77248706231/);
  assert.match(error, /Transaction Time: Aug 3, 1:51 AM/);
});
test("extracts Individual Service Year out-of-pocket values", () => {
  const result = parseAvailityBcbsBenefits(`
    Health Benefit Plan Coverage - 30
    Out Of Pocket
    Information / Details
    Individual
    Family
    In Network
    Place of Service: Office
    $5,000 / Service Year(s)
    $3,002.23 Remaining
    -$1,997.77 Year to Date
    $10,000 / Service Year(s)
    $8,002.23 Remaining
    Professional (Physician) Visit - Office - 98
  `, "ABC123");
  assert.equal(result.outOfPocket, "$5,000");
  assert.equal(result.outOfPocketMet, "$3,002.23");
});
test("extracts professional coinsurance when copay is a dash", () => {
  const result = parseAvailityBcbsBenefits(`
    Professional (Physician) Visit - Office - 98
    Coverage Level: Individual
    30% / Calendar Year(s)
    —
    OFFICE VISIT - PROFESSIONAL
  `, "ABC123");
  assert.equal(result.coinsurance, "30%");
  assert.equal(result.copay, "");
});
test("captures an Availity submission error for the Excel Error column", () => {
  const error = extractAvailityPortalError(`
    Submission Error
    Your request was invalid. Subscriber IDs cannot include an alpha-prefix that begins with JLX, JYN, XOD, XOJ, YDJ, YDL, YDV, YID, YIJ, YUB, YUW, YUX, ZGD, ZGJ, or ZZT.
    To submit an inquiry with one of these alpha-prefixes, please submit the inquiry through Blue Cross Medicare Advantage.
  `);
  assert.equal(
    error,
    "Submission Error: Your request was invalid. Subscriber IDs cannot include an alpha-prefix that begins with JLX, JYN, XOD, XOJ, YDJ, YDL, YDV, YID, YIJ, YUB, YUW, YUX, ZGD, ZGJ, or ZZT. To submit an inquiry with one of these alpha-prefixes, please submit the inquiry through Blue Cross Medicare Advantage.",
  );
});