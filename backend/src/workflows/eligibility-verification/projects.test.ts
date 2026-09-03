import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  credentialProjectMatches,
  parseEligibilityProjectId,
  scopeEligibilityInputFile,
} from "./projects";

function workbookFile(rows: Record<string, string>[]): File {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Eligibility");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const bytes = new Uint8Array(buffer.byteLength);
  bytes.set(buffer);
  return new File([bytes], "eligibility.xlsx");
}

async function rows(file: File): Promise<Record<string, string>[]> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  return XLSX.utils.sheet_to_json(workbook.Sheets.Eligibility, { defval: "", raw: false });
}

test("keeps TPM as a Minimax alias and normalizes MedRevenue spellings", () => {
  assert.equal(parseEligibilityProjectId("minimax"), "minimax");
  assert.equal(credentialProjectMatches("minimax", "TPM"), true);
  assert.equal(parseEligibilityProjectId("Medrevenu"), "medrevenue");
  assert.equal(credentialProjectMatches("medrevenue", "Med Revenue"), true);
});

test("scopes mixed eligibility input rows to the selected project", async () => {
  const file = workbookFile([
    { Project: "TPM", Group: "Legacy Group", Payer: "Aetna" },
    { Project: "MedRevenue", Group: "MR Group", Payer: "Humana" },
  ]);
  const scoped = await scopeEligibilityInputFile(file, "medrevenue");
  assert.deepEqual(await rows(scoped), [
    { Project: "MedRevenue", Group: "MR Group", Payer: "Humana" },
  ]);
});

test("preserves legacy Minimax input without a Project column", async () => {
  const file = workbookFile([{ Group: "Existing Group", Payer: "Aetna" }]);
  assert.strictEqual(await scopeEligibilityInputFile(file, "minimax"), file);
  await assert.rejects(
    () => scopeEligibilityInputFile(file, "medrevenue"),
    /must contain a Project column/,
  );
  assert.strictEqual(
    await scopeEligibilityInputFile(file, "medrevenue", { requireProjectColumn: false }),
    file,
  );
});
