import assert from "node:assert/strict";
import test from "node:test";
import { getAvailityEligibilityPayer } from "../registry";

test("Availity eligibility resolves BCBS through its payer registry", () => {
  const payer = getAvailityEligibilityPayer("bcbs");

  assert.equal(payer.id, "bcbs");
  assert.equal(payer.name, "Blue Cross Blue Shield");
});

test("Availity eligibility resolves Van Lang IPA independently", () => {
  const payer = getAvailityEligibilityPayer("van-lang-ipa");

  assert.equal(payer.id, "van-lang-ipa");
  assert.equal(payer.name, "Van Lang IPA");
});

test("Amerigroup and Wellpoint reuse the Van Lang IPA handler", () => {
  const vanLangIpa = getAvailityEligibilityPayer("van-lang-ipa");

  assert.strictEqual(getAvailityEligibilityPayer("amerigroup"), vanLangIpa);
  assert.strictEqual(getAvailityEligibilityPayer("wellpoint"), vanLangIpa);
});
