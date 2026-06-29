import assert from "node:assert/strict";
import test from "node:test";
import { createUniqueMemberWorkItems } from "../input";
import type { BlueShieldInputRow } from "../types";

function row(inputRowId: number, memberId: string, dos: string): BlueShieldInputRow {
  return {
    inputRowId,
    memberId,
    dos,
    validationStatus: "valid",
    validationMessage: "",
  };
}

test("groups duplicate Blue Shield input rows by normalized member ID and DOS", () => {
  const workItems = createUniqueMemberWorkItems([
    row(2, " ABC 123 ", "1/2/2026"),
    row(3, "ABC123", "01/02/2026"),
    row(4, "ABC123", "01/03/2026"),
  ]);

  assert.equal(workItems.length, 2);
  assert.deepEqual(workItems[0], {
    memberId: "ABC123",
    dosValues: ["1/2/2026"],
    rowIds: [2],
    duplicateRowIds: [3],
  });
  assert.deepEqual(workItems[1], {
    memberId: "ABC123",
    dosValues: ["01/03/2026"],
    rowIds: [4],
    duplicateRowIds: [],
  });
});
