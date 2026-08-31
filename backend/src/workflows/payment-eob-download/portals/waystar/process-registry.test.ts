import assert from "node:assert/strict";
import test from "node:test";
import { normalizeWaystarClientName, resolveWaystarPaymentProcess } from "./process-registry";

test("routes Cash Log and Zero Payments clients", () => {
  for (const client of ["Posada", "BPH", "ESC", "PSCD", "SSCE"]) {
    assert.equal(resolveWaystarPaymentProcess(client), "cash-log-and-zero-payments");
  }
});

test("routes Bulk EOB Download clients", () => {
  for (const client of ["TAJ", "GEH", "BCO", "TWL", "WMGU", "JTC"]) {
    assert.equal(resolveWaystarPaymentProcess(client), "bulk-eob-download");
  }
});

test("normalizes client names and rejects unknown clients", () => {
  assert.equal(normalizeWaystarClientName("  T-A_J "), "taj");
  assert.equal(resolveWaystarPaymentProcess(" t-a_j "), "bulk-eob-download");
  assert.equal(resolveWaystarPaymentProcess("TAJ - Tariq Jamil, MD (247864)"), "bulk-eob-download");
  assert.equal(resolveWaystarPaymentProcess("Posada Ambulatory Surgery Center"), "cash-log-and-zero-payments");
  assert.throws(() => resolveWaystarPaymentProcess("Unknown"), /Unsupported Waystar Client Name/);
});
