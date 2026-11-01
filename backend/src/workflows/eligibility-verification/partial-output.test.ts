import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { createEligibilityPartialOutput } from "./partial-output";

test("shared eligibility snapshot keeps submitted rows and saves completed results in Excel row order", async () => {
  const input = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(input, XLSX.utils.aoa_to_sheet([
    ["Patient Name", "Member ID"],
    ["First", "100"],
    ["Second", "200"],
  ]), "Input");
  const file = new File([XLSX.write(input, { type: "buffer", bookType: "xlsx" })], "eligibility.xlsx");
  const snapshot = await createEligibilityPartialOutput(file, "waystar");
  assert.equal(snapshot.filename, "waystar-eligibility-partial-output.xlsx");
  assert.equal(snapshot.record({ type: "eligibility_waystar_result", rowIndex: 3, update: { __rowKey: "3", "Coverage Status": "active" } }), false);
  assert.equal(snapshot.record({ type: "progress", completed: 1 }), true);
  snapshot.markSaved();
  assert.equal(snapshot.hasUnsavedRows(), false);
  assert.equal(snapshot.record({ type: "eligibility_waystar_result", rowIndex: 2, update: { "Coverage Status": "inactive" } }), false);
  assert.equal(snapshot.hasUnsavedRows(), true);

  const output = XLSX.read(snapshot.build(), { type: "buffer" });
  assert.deepEqual(XLSX.utils.sheet_to_json(output.Sheets.Input, { header: 1 }), [
    ["Patient Name", "Member ID"], ["First", "100"], ["Second", "200"],
  ]);
  assert.deepEqual(XLSX.utils.sheet_to_json(output.Sheets["Partial Results"], { header: 1 }), [
    ["Excel Row", "Coverage Status"], [2, "inactive"], [3, "active"],
  ]);
});
