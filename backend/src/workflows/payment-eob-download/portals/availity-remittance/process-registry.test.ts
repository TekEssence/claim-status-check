import assert from "node:assert/strict";
import test from "node:test";
import { isMedRevenuePendingEftRow, resolveAvailityRemittanceProcess } from "./process-registry";

test("defaults legacy Availity credentials to CHARM", () => {
  assert.equal(resolveAvailityRemittanceProcess(""), "charm");
  assert.equal(resolveAvailityRemittanceProcess("CHARM"), "charm");
});

test("resolves MedRevenue aliases and rejects unsupported projects", () => {
  assert.equal(resolveAvailityRemittanceProcess("Med Revenue"), "medrevenue");
  assert.equal(resolveAvailityRemittanceProcess("MEDREV"), "medrevenue");
  assert.throws(() => resolveAvailityRemittanceProcess("Other"), /Unsupported Availity Project/);
});

test("MedRevenue Phase 1 requires both Pending status and EFT mode", () => {
  assert.equal(isMedRevenuePendingEftRow({ entryStatus: " Pending ", modeOfPayment: "eft" }), true);
  assert.equal(isMedRevenuePendingEftRow({ entryStatus: "Pending", modeOfPayment: "Check" }), false);
  assert.equal(isMedRevenuePendingEftRow({ entryStatus: "Complete", modeOfPayment: "EFT" }), false);
});
