import assert from "node:assert/strict";
import test from "node:test";
import { parseUhcEligibilityResultText } from "../payers/uhc-wellmed/workflow";

test("maps the UHC screenshot layout using the requested business rules", () => {
  const result = parseUhcEligibilityResultText(`
    Policy Selected: Tx Uhc Dual Complete HMOPOS Co Qmb H4514-024-000 W
    Active(04/01/2026 - 12/31/2026)
    UNITEDHEALTHCARE
    Plan Name
    Tx Uhc Dual Complete HMOPOS Co Qmb H4514-024-000 W
    Plan Type
    Medicare Primary
    Coordination of Benefits
    UHC Payer Status: Primary
    Deductibles & Maximums
    Network Status
    In-Network
    Individual, In-Network
    Plan Deductible Per Calendar Year
    $283.00 of $283.00 Met
    $0.00 Remaining: $0.00 $283.00
    Out-of-Pocket Maximum Per Calendar Year
    $2,793.88 of $9,250.00 Met
    $0.00 Remaining: $6,456.12 $9,250.00
    POPULAR SERVICES COVERAGE
    Service
    Deductible Information
    Copay
    Coinsurance
    Status
    Specialist Visit
    View detailed benefits
    $0.00 / visit
    20%
    Active
  `);

  assert.equal(result["Coverage Status"], "Active");
  assert.equal(result["Eff Date"], "04/01/2026");
  assert.equal(result["End Date"], "12/31/2026");
  assert.equal(result["Plan Type"], "Medicare Primary");
  assert.equal(result["Bot Insurance Type"], "Tx Uhc Dual Complete HMOPOS Co Qmb H4514-024-000 W");
  assert.equal(result.Network, "In-Network");
  assert.equal(result.Deductible, "$283.00");
  assert.equal(result["Deductible Met"], "$283.00");
  assert.equal(result["Out of Pocket"], "$9,250.00");
  assert.equal(result["Out of Pocket Met"], "$2,793.88");
  assert.equal(result.Copay, "$0.00 / visit");
  assert.equal(result.Coinsurance, "20%");
  assert.equal(result["Other Ins"], "");
  assert.equal(result["Other Ins Eff Date"], "");
});
test("maps network and maximums when the individual heading is omitted", () => {
  const result = parseUhcEligibilityResultText(`
    Deductibles & Maximums
    Network Status
    In-Network
    Plan Deductible Per Calendar Year
    $125.00 of $500.00 Met
    Out-of-Pocket Maximum Per Calendar Year
    $900.00 of $5,000.00 Met
    POPULAR SERVICES COVERAGE
  `);

  assert.equal(result.Network, "In-Network");
  assert.equal(result.Deductible, "$500.00");
  assert.equal(result["Deductible Met"], "$125.00");
  assert.equal(result["Out of Pocket"], "$5,000.00");
  assert.equal(result["Out of Pocket Met"], "$900.00");
});