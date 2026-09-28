import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  readAvailityEligibilityInputRouting,
  readAvailityEligibilityInputPayer,
  readAvailityEligibilityInputPayers,
  resolveAvailityEligibilityInputPayer,
} from "../input-routing";

function inputFile(rows: Array<Record<string, string>>): File {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Eligibility");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([buffer], "eligibility.xlsx");
}

test("maps input payer names to independent Availity handlers", () => {
  assert.equal(resolveAvailityEligibilityInputPayer("Blue Cross Blue Shield"), "bcbs");
  assert.equal(resolveAvailityEligibilityInputPayer("BCBSTX"), "bcbs");
  assert.equal(resolveAvailityEligibilityInputPayer("Van Lang IPA"), "van-lang-ipa");
  assert.equal(resolveAvailityEligibilityInputPayer("Amerigroup"), "amerigroup");
  assert.equal(resolveAvailityEligibilityInputPayer("Wellpoint"), "wellpoint");
});

test("reads a single payer from the input eligibility workbook", async () => {
  assert.equal(await readAvailityEligibilityInputPayer(inputFile([
    { "Primary Insurance Name": "Blue Cross Blue Shield", "Member ID": "B1" },
  ])), "bcbs");
});

test("groups shuffled multiple-payer rows in first-occurrence order", async () => {
  const batches = await readAvailityEligibilityInputPayers(inputFile([
    { Payer: "Wellpoint", "Member ID": "W1" },
    { Payer: "BCBS", "Member ID": "B1" },
    { Payer: "Amerigroup", "Member ID": "A1" },
    { Payer: "Wellpoint", "Member ID": "W2" },
  ]));

  assert.deepEqual(batches.map(({ payerId, rowCount }) => ({ payerId, rowCount })), [
    { payerId: "wellpoint", rowCount: 2 },
    { payerId: "bcbs", rowCount: 1 },
    { payerId: "amerigroup", rowCount: 1 },
  ]);

  const wellpointWorkbook = XLSX.read(await batches[0].inputFile.arrayBuffer(), { type: "array" });
  const wellpointRows = XLSX.utils.sheet_to_json<Record<string, string>>(
    wellpointWorkbook.Sheets[wellpointWorkbook.SheetNames[0]],
  );
  assert.deepEqual(wellpointRows.map((row) => row["Member ID"]), ["W1", "W2"]);
});

test("keeps supported payer batches when other rows are unsupported", async () => {
  const routing = await readAvailityEligibilityInputRouting(inputFile([
    { Payer: "Healthspring", "Member ID": "H1" },
    { Payer: "BCBS", "Member ID": "B1" },
    { Payer: "Wellcare", "Member ID": "W1" },
  ]));

  assert.deepEqual(routing.batches.map(({ payerId, rowCount }) => ({ payerId, rowCount })), [
    { payerId: "bcbs", rowCount: 1 },
    { payerId: "wellcare", rowCount: 1 },
  ]);
  assert.deepEqual(routing.skippedRows, [
    {
      rowNumber: 2,
      payerName: "Healthspring",
      error: 'Unsupported Availity eligibility payer "Healthspring" in the input workbook. Expected Aetna, Aetna Medicare, Blue Cross Blue Shield, Humana, Van Lang IPA, VI Care Health IPA, Amerigroup, Wellpoint, or Wellcare.',
    },
  ]);
});
