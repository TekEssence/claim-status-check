import assert from "node:assert/strict";
import test from "node:test";
import { dateFilePart, parseInstamedRemittanceCsv } from "./scraper";

test("parses InstaMed remittance CSV and skips totals row", () => {
  const records = parseInstamedRemittanceCsv([
    "Payee Name,Payee ID,Workflow Status,Payer Name,Payment Date,Payment Method,Total Claim Count,Total Services,Total Charges,Total Payment,Paid Amount,Provider Adj,Total Patient Responsibility,Total Non-Covered Charges,Check / EFT Trace #",
    "KIM HANSEN ND,1881080349,Received,KFHP of WA,06/03/2026 12:00:00 AM,ACH,1,1,$257.00,$123.60,$123.60,$0.00,$0.00,$133.40,43850403",
    "Totals:,,,,,,,,$257.00,$123.60,$123.60,$0.00,$0.00,$133.40,",
  ].join("\n"));

  assert.equal(records.length, 1);
  assert.equal(records[0].checkNumber, "43850403");
  assert.equal(records[0].checkDate, "06/03/2026 12:00:00 AM");
  assert.equal(records[0].payer, "KFHP of WA");
  assert.equal(records[0].payee, "KIM HANSEN ND");
  assert.equal(records[0].amount, "$123.60");
});

test("formats payment date for InstaMed EDI filenames", () => {
  assert.equal(dateFilePart("07/01/2026"), "2026-07-01");
  assert.equal(dateFilePart("07/01/2026 12:00:00 AM"), "2026-07-01");
});
