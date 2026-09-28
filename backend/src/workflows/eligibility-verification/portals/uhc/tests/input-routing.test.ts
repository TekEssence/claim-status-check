import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { readUhcEligibilityInputRows } from "../payers/uhc-wellmed/workflow";

async function worksheet(rows: unknown[][]): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Eligibility");
  sheet.addRows(rows);
  return sheet;
}

test("UHC input routing skips unsupported payer rows without dropping supported rows", async () => {
  const routing = readUhcEligibilityInputRows(await worksheet([
    ["Payer", "Member ID", "DOB"],
    ["Healthspring", "H1", "01/01/1950"],
    ["UHC", "U1", "02/02/1950"],
    ["United Healthcare", "U2", "03/03/1950"],
  ]));

  assert.deepEqual(routing.rows.map((row) => row.worksheetRow), [3, 4]);
  assert.deepEqual(routing.skippedRows, [
    {
      worksheetRow: 2,
      payerName: "Healthspring",
      error: 'Unsupported UHC eligibility payer "Healthspring" in the input workbook. Expected UHC, United Healthcare, United Health Care, United Healthcare Dual Complete, UHC Medicare Advantage, United Health Choice Plus Network, United Healthcare Community Plan TX, AARP Medicare Advantage Wellmed, Surest, or Wellmed.',
    },
  ]);
  assert.equal(routing.totalRows, 3);
});

test("UHC dedicated workbooks without payer columns keep legacy all-row behavior", async () => {
  const routing = readUhcEligibilityInputRows(await worksheet([
    ["Member ID", "DOB"],
    ["U1", "02/02/1950"],
    ["U2", "03/03/1950"],
  ]));

  assert.deepEqual(routing.rows.map((row) => row.worksheetRow), [2, 3]);
  assert.deepEqual(routing.skippedRows, []);
  assert.equal(routing.totalRows, 2);
});
