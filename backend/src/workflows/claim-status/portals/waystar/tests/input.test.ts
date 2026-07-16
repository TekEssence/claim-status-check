import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { parseWaystarClaimWorkbook } from "../input";

test("reads Waystar claim workbook rows and sends invalid rows to the error bucket", async () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.json_to_sheet([
    { "Patient Name": "John Doe", "Claim Number": "ABC123", "Responsible Payer": "Medicare", DOS: "01/15/2026" },
    { "Patient Name": "", "Claim Number": "XYZ999", "Responsible Payer": "BCBS", DOS: "01/20/2026" },
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Claims");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const file = new File([buffer], "waystar-claims.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });

  const parsed = await parseWaystarClaimWorkbook(file);

  assert.equal(parsed.totalRows, 2);
  assert.equal(parsed.claimRows.length, 1);
  assert.equal(parsed.invalidRows.length, 1);
  assert.equal(parsed.claimRows[0].patientName, "John Doe");
  assert.equal(parsed.claimRows[0].claimNumber, "ABC123");
  assert.equal(parsed.claimRows[0].responsiblePayer, "Medicare");
  assert.equal(parsed.claimRows[0].dos, "01/15/2026");
  assert.match(parsed.invalidRows[0].error, /Patient Name/);
});
