import assert from "node:assert/strict";
import test from "node:test";
import { isMedRevenuePendingEftRow, resolveZelisProcess } from "./process-registry";

test("Zelis defaults a blank project to Charm", () => {
  assert.equal(resolveZelisProcess(""), "charm");
  assert.equal(resolveZelisProcess("CHARM"), "charm");
});

test("Zelis resolves MedRevenue project variants without a client restriction", () => {
  assert.equal(resolveZelisProcess("Med Revenue"), "medrevenue");
  assert.equal(resolveZelisProcess("MEDREV"), "medrevenue");
});

test("Zelis MedRevenue includes only Pending EFT Control Log rows", () => {
  assert.equal(isMedRevenuePendingEftRow({ entryStatus: "Pending", modeOfPayment: "EFT" }), true);
  assert.equal(isMedRevenuePendingEftRow({ entryStatus: "pending ", modeOfPayment: " eft " }), true);
  assert.equal(isMedRevenuePendingEftRow({ entryStatus: "Posted", modeOfPayment: "EFT" }), false);
  assert.equal(isMedRevenuePendingEftRow({ entryStatus: "Pending", modeOfPayment: "Check" }), false);
});

test("Zelis rejects unsupported projects", () => {
  assert.throws(() => resolveZelisProcess("Unknown"), /Unsupported Zelis Project/);
});
