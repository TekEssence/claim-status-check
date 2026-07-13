import assert from "node:assert/strict";
import test from "node:test";
import { findWaystarServiceTypeOption } from "../portal";

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
