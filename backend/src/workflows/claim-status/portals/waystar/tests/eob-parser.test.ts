import assert from "node:assert/strict";
import test from "node:test";
import { parseWaystarEobText } from "../portal";

test("maps Waystar EOB procedure lines and glossary denial reasons", () => {
  const text = [
    "NAME: John Doe",
    "ICN: ABC12345",
    "CHECK DATE: 01/18/2026",
    "PROC REMARK",
    "99291 CO-16",
    "99292 CO-45",
    "SUB TOTALS Paid 0.00 Allowed 0.00",
    "Glossary",
    "CO-16 Lack of information needed for adjudication.",
    "CO-45 Charge exceeds fee schedule.",
  ].join("\n");

  const parsed = parseWaystarEobText(text);

  assert.equal(parsed.name, "John Doe");
  assert.equal(parsed.icn, "ABC12345");
  assert.equal(parsed.checkDate, "01/18/2026");
  assert.equal(parsed.status, "Denial");
  assert.equal(parsed.procedureLines.length, 2);
  assert.equal(parsed.procedureLines[0].proc, "99291");
  assert.deepEqual(parsed.procedureLines[0].denialCodes, ["CO-16"]);
  assert.match(parsed.procedureLines[0].denialReasons[0] || "", /information needed/i);
  assert.deepEqual(parsed.procedureLines[1].denialCodes, ["CO-45"]);
  assert.match(parsed.procedureLines[1].denialReasons[0] || "", /fee schedule/i);
});


test("parses Waystar PDF-style EOB table rows and wrapped denial codes", () => {
  const text = [
    "NAME: JOHN DOE",
    "ACNT: 4009/269048           ICN: 60497156",
    "CHECK DATE: 04/14/2026",
    "DATE POS NOS PROC MODS BILLED ALLOWED DEDUCT COINS GRP/RC--AMT PROV PD",
    "40226 11 1 99204 25 500.00 193.32 0.00 0.00 CO-24 173.32 0.00",
    "CO-45 306.68",
    "PR-3 20.00",
    "40226 11 1 51798 70.00 70.00 0.00 0.00 70.00 70.00",
    "SUB TOTALS 570.00 263.32 0.00 0.00 500.00 70.00",
    "Glossary. Reason, MOA, and Remark codes",
    "CO-24 Charges are covered under a capitation agreement.",
    "CO-45 Charge exceeds fee schedule/maximum allowable.",
    "PR-3 Co-payment amount.",
  ].join("\n");

  const parsed = parseWaystarEobText(text);

  assert.equal(parsed.name, "JOHN DOE");
  assert.equal(parsed.icn, "60497156");
  assert.equal(parsed.checkDate, "04/14/2026");
  assert.equal(parsed.procedureLines.length, 2);
  assert.equal(parsed.procedureLines[0].proc, "99204");
  assert.match(parsed.procedureLines[0].subTotals, /SUB TOTALS/i);
  assert.deepEqual(parsed.procedureLines[0].denialCodes, ["CO-24", "CO-45", "PR-3"]);
  assert.match(parsed.procedureLines[0].denialReasons[0] || "", /capitation agreement/i);
  assert.match(parsed.procedureLines[0].denialReasons[1] || "", /fee schedule/i);
  assert.match(parsed.procedureLines[0].denialReasons[2] || "", /co-payment amount/i);
  assert.equal(parsed.procedureLines[1].proc, "51798");
});


test("ignores MBR and account lines when parsing Waystar PDF-style EOBs", () => {
  const text = [
    "NAME",
    "MBR:912740113000 ACNT:4009/269048 ICN:60497156",
    "CHECK DATE: 04/14/2026",
    "11 1 99204 25 500.00 193.32 0.00 0.00 CO-24 173.32 0.00",
    "11 1 51798 70.00 70.00 0.00 0.00 70.00 70.00",
    "SUB TOTALS 570.00 263.32 0.00 0.00 500.00 70.00",
    "Glossary",
    "CO-24 Charges are covered under a capitation agreement.",
  ].join("\n");

  const parsed = parseWaystarEobText(text);

  assert.equal(parsed.name, "");
  assert.equal(parsed.icn, "60497156");
  assert.equal(parsed.procedureLines.length, 2);
  assert.equal(parsed.procedureLines[0].proc, "99204");
  assert.equal(parsed.procedureLines[1].proc, "51798");
});


test("maps OCR-style denial reason lines without creating fake PROC rows", () => {
  const text = [
    "NAME: JOHN DOE",
    "MBR:912740113000 ACNT:4009/269048 ICN:60497156",
    "CHECK DATE: 04/14/2026",
    "11 1 99204 25 500.00 193.32 0.00 0.00 CO-24 173.32 0.00",
    "CO-45 306.68",
    "PR-3 20.00",
    "11 1 51798 70.00 70.00 0.00 0.00 70.00 70.00",
    "SUB TOTALS 570.00 263.32 0.00 0.00 500.00 70.00",
    "Glossary. Reason, MOA, and Remark codes",
    "24Charges are covered under a capitation agreement/managed care plan.",
    "45Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.",
    "3 Co-payment Amount",
  ].join("\n");

  const parsed = parseWaystarEobText(text);

  assert.equal(parsed.account, "269048");
  assert.equal(parsed.procedureLines.length, 2);
  assert.deepEqual(parsed.procedureLines.map((line) => line.proc), ["99204", "51798"]);
  assert.equal(parsed.procedureLines[0].billed, "500.00");
  assert.equal(parsed.procedureLines[0].allowed, "193.32");
  assert.equal(parsed.procedureLines[0].deduct, "0.00");
  assert.equal(parsed.procedureLines[0].coins, "0.00");
  assert.equal(parsed.procedureLines[0].provPd, "0.00");
  assert.deepEqual(parsed.procedureLines[0].denialCodes, ["CO-24", "CO-45", "PR-3"]);
  assert.match(parsed.procedureLines[0].denialReasons[0] || "", /capitation agreement/i);
  assert.match(parsed.procedureLines[0].denialReasons[1] || "", /fee schedule/i);
  assert.match(parsed.procedureLines[0].denialReasons[2] || "", /co-payment amount/i);
});
