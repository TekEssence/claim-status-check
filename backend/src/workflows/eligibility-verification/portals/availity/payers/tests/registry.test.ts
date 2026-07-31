import assert from "node:assert/strict";
import test from "node:test";
import { getAvailityEligibilityPayer } from "../registry";

test("Availity eligibility resolves BCBS through its payer registry", () => {
  const payer = getAvailityEligibilityPayer("bcbs");

  assert.equal(payer.id, "bcbs");
  assert.equal(payer.name, "Blue Cross Blue Shield");
});
