import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { readAvailityEligibilityInputPayer, resolveAvailityEligibilityInputPayer } from "../input-routing";

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
});

test("reads BCBS from the input eligibility workbook", async () => {
  assert.equal(await readAvailityEligibilityInputPayer(inputFile([
    { "Primary Insurance Name": "Blue Cross Blue Shield", "Member ID": "B1" },
  ])), "bcbs");
});

test("reads Van Lang IPA from the input eligibility workbook", async () => {
  assert.equal(await readAvailityEligibilityInputPayer(inputFile([
    { "Payer Name": "Van Lang IPA", "Member ID": "V1" },
  ])), "van-lang-ipa");
});

test("rejects a mixed-payer input workbook", async () => {
  await assert.rejects(readAvailityEligibilityInputPayer(inputFile([
    { Payer: "BCBS" },
    { Payer: "Van Lang IPA" },
  ])), /one payer per run/);
});