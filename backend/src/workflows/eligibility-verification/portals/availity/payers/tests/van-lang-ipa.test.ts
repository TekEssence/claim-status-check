import assert from "node:assert/strict";
import test from "node:test";
import { hasUsableVanLangEligibilityResult, parseAvailitySnapshotBasics, parseAvailityVanLangIpaBenefits, parseRestrictedProviderInformation, parseRestrictedProviderName } from "../van-lang-ipa/workflow";

test("uses the Services Restricted to Following Provider name as Van Lang other insurance", () => {
  const result = parseRestrictedProviderInformation(`
    Provider Information
    Requesting Provider
    Name: DAO, THUAN
    Primary Care Provider
    Name: TRUONG, THANH-THAO Q
    Services Restricted to
    Following Provider
    Name: VAN LANG
    Category: Services Restricted to Following Provider
    Type: Independent Physicians Association (IPA)
    NPI: 1043686702
    Primary Care Provider Start Date:
    Apr 1, 2024
    Primary Care Provider End Date:
    Dec 31, 9999
    Contact Information
  `);
  assert.deepEqual(result, { name: "VAN LANG", effectiveDate: "Apr 1, 2024 - Dec 31, 9999" });
});

test("leaves Van Lang restricted provider blank when that section is absent", () => {
  assert.equal(parseRestrictedProviderName("No additional payer information provided."), "");
});
test("extracts Van Lang out-of-pocket calendar-year and year-to-date amounts", () => {
  const result = parseAvailityVanLangIpaBenefits(`
    Plan Maximums and Deductibles
    FILTER BY NETWORK
    Out of Network In Network All Networks
    Health Benefit Plan Coverage - 30
    Active Coverage
    Insurance Type: Medicare Primary
    Plan / Product: TX H8849-009-000 WELLPOINT SELECT (HMO-POS) RISK
    Information / Details Individual
    In Network
    Out Of Pocket
    Benefit Start Date: Jan 1, 2026
    Benefit End Date: Dec 31, 9999
    $3,400 / Calendar Year(s)
    -$210.90 Year to Date
    $3,189.10 Remaining
  `, "ABC123");

  assert.equal(result.outOfPocket, "$3,400");
  assert.equal(result.outOfPocketMet, "$210.90");
});
test("selects coinsurance and copayment from the Van Lang specialist row", () => {
  const result = parseAvailityVanLangIpaBenefits(`
    Health Benefit Plan Coverage - 30
    Professional (Physician) Visit - Office - 98
    Information / Details Co-Insurance Co-Payment Benefit Deductible Limitations Authorization
    In Network
    Coverage Level: Individual
    Benefit Start Date: Jan 1, 2026
    Benefit End Date: Dec 31, 9999
    —
    $0
    In Network
    Coverage Level: Individual
    Benefit Start Date: Jan 1, 2026
    Benefit End Date: Dec 31, 9999
    —
    $20 / Visit(s)
    SPECIALIST
    In Network
    Place of Service: Walk-in Retail Health Clinic
    Coverage Level: Individual
    Benefit Start Date: Jan 1, 2026
    Benefit End Date: Dec 31, 9999
    —
    $0
  `, "ABC123");

  assert.equal(result.coinsurance, "");
  assert.equal(result.copay, "$20");
});
test("recognizes a loaded Wellpoint result that uses Active Coverage instead of Member Status", () => {
  const text = `
    Plan Maximums and Deductibles
    Health Benefit Plan Coverage - 30
    Active Coverage
    Insurance Type: Medicare Primary
  `;
  assert.equal(hasUsableVanLangEligibilityResult(text), true);
  assert.equal(parseAvailitySnapshotBasics(text).coverageStatus, "Active");
});

test("uses Year to Date for Van Lang deductible met and out-of-pocket met", () => {
  const result = parseAvailityVanLangIpaBenefits(`
    Health Benefit Plan Coverage - 30
    Coverage Level: Individual
    Annual Deductible
    In Network
    $650 / Calendar Year(s)
    $0 Remaining
    -$650 Year to Date
    Out Of Pocket
    In Network
    $7,000 / Calendar Year(s)
    $5,821.42 Remaining
    -$1,178.58 Year to Date
  `, "ABC123");

  assert.equal(result.deductible, "$650");
  assert.equal(result.deductibleMet, "$650");
  assert.equal(result.outOfPocket, "$7,000");
  assert.equal(result.outOfPocketMet, "$1,178.58");
});