import assert from "node:assert/strict";
import test from "node:test";
import { parseUhcEligibilityResultText, shouldRetryNoResult, UHC_OUTPUT_HEADERS } from "../payers/uhc-wellmed/workflow";

test("extracts the requested UHC/Wellmed eligibility output fields", () => {
  const result = parseUhcEligibilityResultText(`
    Member Status: Active
    Effective Date
    01/01/2026
    Termination Date
    12/31/2026
    Other Insurance
    Medicare
    Other Insurance Effective Date
    02/01/2026
    Relationship to Subscriber
    Self
    Plan Type
    HMO
    Insurance Type
    Medicare Advantage
    Network
    In Network
    Coinsurance
    20%
    Copay
    $25
    Deductible
    $500
    Deductible Met
    $125
    Out of Pocket
    $5,000
    Out of Pocket Met
    $900
  `);

  assert.deepEqual(Object.keys(result), [...UHC_OUTPUT_HEADERS]);
  assert.deepEqual(result, {
    "Coverage Status": "Active",
    "Eff Date": "01/01/2026",
    "End Date": "12/31/2026",
    "Other Ins": "Medicare",
    "Other Ins Eff Date": "02/01/2026",
    "Relationship to Subscriber": "Self",
    "Plan Type": "HMO",
    "Bot Insurance Type": "Medicare Advantage",
    "Network": "In Network",
    "Coinsurance": "20%",
    "Copay": "$25",
    "Deductible": "$500",
    "Deductible Met": "$125",
    "Out of Pocket": "$5,000",
    "Out of Pocket Met": "$900",
    "Error": "",
  });
});

test("does not confuse totals with their met values", () => {
  const result = parseUhcEligibilityResultText(`
    Deductible Met
    $100
    Deductible
    $1,000
    Out of Pocket Met
    $300
    Out of Pocket
    $5,000
  `);

  assert.equal(result.Deductible, "$1,000");
  assert.equal(result["Deductible Met"], "$100");
  assert.equal(result["Out of Pocket"], "$5,000");
  assert.equal(result["Out of Pocket Met"], "$300");
});
test("ignores UHC material icon text between result labels and values", () => {
  const result = parseUhcEligibilityResultText(`
    Coverage Status
    keyboard_arrow_down
    Active
    Effective Date
    keyboard_arrow_down
    01/01/2026
    End Date
    keyboard_arrow_down
    12/31/2026
    Relationship to Subscriber
    keyboard_arrow_down
    Self
  `);

  assert.equal(result["Coverage Status"], "Active");
  assert.equal(result["Eff Date"], "01/01/2026");
  assert.equal(result["End Date"], "12/31/2026");
  assert.equal(result["Relationship to Subscriber"], "Self");
});
test("extracts AARP coverage when UHC labels the field only as Coverage", () => {
  const result = parseUhcEligibilityResultText(`
    Policy Selected: AARP Medicare Advantage Wellmed
    Coverage
    keyboard_arrow_down
    Active
    Plan Type
    Point of Service (POS)
  `);

  assert.equal(result["Coverage Status"], "Active");
});
test("extracts AARP effective date when the policy end date is Present", () => {
  const result = parseUhcEligibilityResultText(`
    Policy Selected: HMOPOS-AARP Medicare Advantage Extras From UHC TX
    Active(02/01/2026 - Present)
    Service Dates Requested: 08/08/2026 - 08/08/2026
  `);

  assert.equal(result["Coverage Status"], "Active");
  assert.equal(result["Eff Date"], "02/01/2026");
  assert.equal(result["End Date"], "Present");
});
test("maps text-only no deductible and no out-of-pocket messages to zero", () => {
  const result = parseUhcEligibilityResultText(`
    Individual, In-Network
    Plan Deductible
    Member's plan does not have a deductible.
    Out-of-Pocket Maximum
    Member's plan does not have an out-of-pocket maximum.
  `);

  assert.equal(result.Deductible, "$0.00");
  assert.equal(result["Deductible Met"], "$0.00");
  assert.equal(result["Out of Pocket"], "$0.00");
  assert.equal(result["Out of Pocket Met"], "$0.00");
});
test("retries only ambiguous UHC no-result responses", () => {
  assert.equal(shouldRetryNoResult("No Results Found"), true);
  assert.equal(shouldRetryNoResult("Your search returned no results with the Member ID you submitted."), true);
  assert.equal(shouldRetryNoResult("Policies were found outside of the entered date range."), false);
});
