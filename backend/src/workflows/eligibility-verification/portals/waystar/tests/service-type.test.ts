import assert from "node:assert/strict";
import test from "node:test";
import { findWaystarPatientLookupOption, findWaystarServiceTypeOption, resolveWaystarServiceTypeCode } from "../portal";

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
test("AV Med payer service type 98 overrides row and credential defaults", () => {
  assert.equal(resolveWaystarServiceTypeCode("98", "30", "30"), "98");
  assert.equal(resolveWaystarServiceTypeCode("98 - Professional (Physician) Visit - Office", undefined, "30"), "98");
});
test("matches the AV Med subscriber ID and demographics lookup option", () => {
  const options = [
    { value: "7", label: "Sbr ID, DOB" },
    { value: "10", label: "Sbr ID, LName, FName, DOB" },
  ];
  assert.deepEqual(findWaystarPatientLookupOption(options, "10"), options[1]);
  assert.deepEqual(
    findWaystarPatientLookupOption([{ value: "different", label: "Sbr ID, LName, FName, DOB" }], "10"),
    { value: "different", label: "Sbr ID, LName, FName, DOB" },
  );
});
