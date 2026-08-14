import assert from "node:assert/strict";
import test from "node:test";
import { payerSearchTerms } from "../portal";

test("Humana 61101 searches using the Humana word alone", () => {
  assert.deepEqual(payerSearchTerms("Humana(61101)"), ["humana"]);
});

test("AARP Medicare Complete never searches Waystar as UHC", () => {
  const payer = "AARP Medicare Advantage Choice Plan (87726)";
  const terms = payerSearchTerms(payer);

  assert.deepEqual(terms, ["AARP Medicare Advantage Choice Plan", payer]);
  assert.equal(terms.includes("UHC"), false);
});

test("United Healthcare 87726 continues to use the UHC search", () => {
  assert.deepEqual(payerSearchTerms("United Healthcare(87726)"), [
    "UHC",
    "United Healthcare(87726)",
  ]);
});
