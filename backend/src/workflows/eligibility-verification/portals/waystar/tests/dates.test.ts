import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWaystarDate } from "../dates";

test("converts DD/MM/two-digit-year dates to Waystar MM/DD/YYYY", () => {
  assert.equal(normalizeWaystarDate("15/7/87"), "07/15/1987");
  assert.equal(normalizeWaystarDate("31-12-99"), "12/31/1999");
});

test("preserves MM/DD dates and expands recent two-digit years", () => {
  assert.equal(normalizeWaystarDate("7/15/1987"), "07/15/1987");
  assert.equal(normalizeWaystarDate("02/03/10"), "02/03/2010");
});

test("accepts ISO dates and rejects impossible dates", () => {
  assert.equal(normalizeWaystarDate("1987-07-15"), "07/15/1987");
  assert.throws(() => normalizeWaystarDate("31/02/1987"), /Invalid date of birth/);
});