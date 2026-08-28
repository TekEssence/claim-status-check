import assert from "node:assert/strict";
import test from "node:test";
import { isEligibleWaystarControlRow, isInProgressStatus, isUsableCheckNumber, isWaystarSource, normalizeAmount, normalizePaymentNumber } from "./input";

test("Waystar payment comparison normalizes check numbers and currency", () => {
  assert.equal(normalizePaymentNumber(" 001 23.0 "), "00123");
  assert.equal(normalizeAmount("$1,000.19"), 100019);
  assert.equal(normalizeAmount("1000.190"), 100019);
});

test("Waystar recognizes punctuation and wording variants of an in-progress status", () => {
  for (const value of ["In Progress", "IN-Progress", "In_Progress", "In-Process", "IN PROCESS"]) {
    assert.equal(isInProgressStatus(value), true, value);
  }
  assert.equal(isInProgressStatus("Completed"), false);
});

test("Waystar processes a row only when Source and Entry Status both qualify", () => {
  for (const value of ["Waystar", "WAY STAR", "way-star", "Way_Star"]) {
    assert.equal(isWaystarSource(value), true, value);
  }
  assert.equal(isEligibleWaystarControlRow({ source: "Waystar", entryStatus: "In-Process" }), true);
  assert.equal(isEligibleWaystarControlRow({ source: "Web", entryStatus: "In-Process" }), false);
  assert.equal(isEligibleWaystarControlRow({ source: "Waystar", entryStatus: "Completed" }), false);
});

test("Waystar rejects placeholder check numbers", () => {
  for (const value of ["", "-", "N/A", "none", "null"]) assert.equal(isUsableCheckNumber(value), false, value);
  assert.equal(isUsableCheckNumber("R35060729007230"), true);
});
