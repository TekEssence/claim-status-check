import assert from "node:assert/strict";
import test from "node:test";
import { parseUhcEligibilityResultText, UHC_OUTPUT_HEADERS } from "../payers/uhc-wellmed/workflow";

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
