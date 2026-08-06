import assert from "node:assert/strict";
import test from "node:test";
import {
  currencyAmountsEqual,
  findLineItemMatch,
  normalizeAdvancedMdDate,
  normalizeCpt,
  normalizeCurrencyCents,
  normalizePatientId,
} from "../line-items";

test("normalizes CPT as text without numeric conversion", () => {
  assert.equal(normalizeCpt("  0012a "), "0012A");
});

test("normalizes currency to cents with strict decimal parsing", () => {
  assert.equal(normalizeCurrencyCents("$1,234.50"), 123450);
  assert.equal(normalizeCurrencyCents("1234.5"), 123450);
  assert.equal(normalizeCurrencyCents("abc123"), null);
  assert.equal(currencyAmountsEqual("$100.00", "100"), true);
  assert.equal(currencyAmountsEqual("$100.01", "100"), false);
});

test("normalizes supported dates to AdvancedMD MM/DD/YYYY format", () => {
  assert.equal(normalizeAdvancedMdDate("1-2-2026"), "01/02/2026");
  assert.equal(normalizeAdvancedMdDate("01/02/26"), "01/02/2026");
  assert.equal(normalizeAdvancedMdDate(new Date(Date.UTC(2026, 0, 2))), "01/02/2026");
});

test("normalizes patient IDs as text and preserves leading zeros", () => {
  assert.equal(normalizePatientId(" 00123 "), "00123");
});

test("matches a unique line item only when CPT and charge both match", () => {
  const result = findLineItemMatch([
    { rowId: "1", code: "99213", charge: "$100.00" },
    { rowId: "2", code: "99214", charge: "$100.00" },
  ], {
    cpt: "99213",
    chargeAmount: "100",
    paymentAmount: "80",
  });

  assert.equal(result.type, "unique");
  if (result.type === "unique") assert.equal(result.lineItem.rowId, "1");
});

test("does not match when CPT or charge differs", () => {
  const result = findLineItemMatch([
    { rowId: "1", code: "99213", charge: "$100.00" },
  ], {
    cpt: "99213",
    chargeAmount: "101",
    paymentAmount: "80",
  });

  assert.equal(result.type, "no-match");
  if (result.type === "no-match") {
    assert.equal(result.cptMatched, true);
    assert.equal(result.chargeMatched, false);
  }
});

test("returns ambiguous when duplicate CPT and charge cannot be disambiguated", () => {
  const result = findLineItemMatch([
    { rowId: "1", code: "99213", charge: "$100.00" },
    { rowId: "2", code: "99213", charge: "$100.00" },
  ], {
    cpt: "99213",
    chargeAmount: "100",
    paymentAmount: "80",
  });

  assert.equal(result.type, "ambiguous");
});

test("uses deterministic optional values to disambiguate duplicates", () => {
  const result = findLineItemMatch([
    { rowId: "1", code: "99213", charge: "$100.00", modifier: "25" },
    { rowId: "2", code: "99213", charge: "$100.00", modifier: "59" },
  ], {
    cpt: "99213",
    chargeAmount: "100",
    paymentAmount: "80",
    modifier: "59",
  });

  assert.equal(result.type, "unique");
  if (result.type === "unique") assert.equal(result.lineItem.rowId, "2");
});

