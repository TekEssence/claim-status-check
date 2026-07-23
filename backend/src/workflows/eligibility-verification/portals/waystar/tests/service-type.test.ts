import assert from "node:assert/strict";
import test from "node:test";
import { findWaystarServiceTypeOption, normalizeDate } from "../portal";

test("matches Waystar service type options by code or full label", () => {
  const options = [
    { value: "", label: "Select Code" },
    { value: "30 - Health Benefit Plan Coverage", label: "30 - Health Benefit Plan Coverage" },
    { value: "1", label: "1 - Medical Care" },
  ];

  assert.deepEqual(findWaystarServiceTypeOption(options, "30"), options[1]);
  assert.deepEqual(findWaystarServiceTypeOption(options, "30 - Health Benefit Plan Coverage"), options[1]);
});

test("ignores placeholder service type options", () => {
  const options = [{ value: "", label: "Select Code" }];

  assert.equal(findWaystarServiceTypeOption(options, "30"), null);
});

test("normalizes two-digit DOB years without pushing past years into the future", () => {
  assert.equal(normalizeDate("7/23/52"), "07/23/1952");
  assert.equal(normalizeDate("7/23/10"), "07/23/2010");
  assert.equal(normalizeDate("7/23/2026"), "07/23/2026");
});
