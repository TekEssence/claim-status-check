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

test("parses CLM Status line items using provider serv date pos nos proc and trailing prov pd", () => {
  const text = [
    "CLM Status:1    MRN:",
    "1881816411 0402 040226 11 1 99204 25 500.00 193.32 0.00 0.00 CO-24 173.32 0.00",
    "CO-45 306.68",
    "PR-3 20.00",
    "1881816411 0402 040226 11 1 51798 70.00 70.00 0.00 0.00 70.00 70.00",
    "PT RESP 20.00",
    "SUB TOTALS: 570.00 263.32 0.00 0.00 500.00 70.00",
    "24Charges are covered under a capitation agreement/managed care plan.",
    "45Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.",
    "3 Co-payment Amount",
  ].join("\n");

  const parsed = parseWaystarEobText(text);

  assert.deepEqual(parsed.procedureLines.map((line) => line.proc), ["99204", "51798"]);
  assert.equal(parsed.procedureLines[0].serviceDate, "2026-04-02");
  assert.equal(parsed.procedureLines[0].billed, "500.00");
  assert.equal(parsed.procedureLines[0].allowed, "193.32");
  assert.equal(parsed.procedureLines[0].deduct, "0.00");
  assert.equal(parsed.procedureLines[0].coins, "0.00");
  assert.equal(parsed.procedureLines[0].provPd, "0.00");
  assert.deepEqual(parsed.procedureLines[0].denialCodes, ["CO-24", "CO-45", "PR-3"]);
  assert.equal(parsed.procedureLines[1].serviceDate, "2026-04-02");
  assert.equal(parsed.procedureLines[1].billed, "70.00");
  assert.equal(parsed.procedureLines[1].allowed, "70.00");
  assert.equal(parsed.procedureLines[1].provPd, "70.00");
});

test("parses CLM Status rows with numeric and alphanumeric proc codes", () => {
  const text = [
    "CLM Status:4    MRN:",
    "1881816411 0422 042226 11 1 55707 1160.00 1160.00 0.00 0.00 CO-197 1160.00 0.00",
    "1881816411 0422 042226 11 1 J1580 15.00 15.00 0.00 0.00 CO-197 15.00 0.00",
    "197Precertification/authorization/notification absent.",
  ].join("\n");

  const parsed = parseWaystarEobText(text);

  assert.deepEqual(parsed.procedureLines.map((line) => line.proc), ["55707", "J1580"]);
  assert.equal(parsed.procedureLines[0].serviceDate, "2026-04-22");
  assert.equal(parsed.procedureLines[0].billed, "1160.00");
  assert.equal(parsed.procedureLines[0].allowed, "1160.00");
  assert.equal(parsed.procedureLines[0].provPd, "0.00");
  assert.deepEqual(parsed.procedureLines[0].denialCodes, ["CO-197"]);
  assert.equal(parsed.procedureLines[1].serviceDate, "2026-04-22");
  assert.equal(parsed.procedureLines[1].billed, "15.00");
  assert.equal(parsed.procedureLines[1].allowed, "15.00");
  assert.equal(parsed.procedureLines[1].provPd, "0.00");
});

test("ignores long provider or member numbers when resolving PROC and preserves OCR denial reason text", () => {
  const text = [
    "NAME: JOHN DOE",
    "MBR:1881816411 ACNT:4009/269048 ICN:60497156",
    "CHECK DATE: 04/14/2026",
    "DATE POS NOS PROC MODS BILLED ALLOWED DEDUCT COINS GRP/RC--AMT PROV PD",
    "40226 11 1 99204 25 500.00 193.32 0.00 0.00 CO-24 173.32 0.00",
    "CO-45 306.68",
    "PR-3 20.00",
    "40226 11 1 51798 70.00 70.00 0.00 0.00 70.00 70.00",
    "SUB TOTALS 570.00 263.32 0.00 0.00 500.00 70.00",
    "Glossary. Reason, MOA, and Remark codes",
    "24Charges are covered under a capitation agreement/managed care plan.",
    "45Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.",
    "3 Co-payment Amount",
  ].join("\n");

  const parsed = parseWaystarEobText(text);

  assert.deepEqual(parsed.procedureLines.map((line) => line.proc), ["99204", "51798"]);
  assert.equal(parsed.procedureLines[0].billed, "500.00");
  assert.equal(parsed.procedureLines[0].allowed, "193.32");
  assert.equal(parsed.procedureLines[0].deduct, "0.00");
  assert.equal(parsed.procedureLines[0].coins, "0.00");
  assert.equal(parsed.procedureLines[0].provPd, "0.00");
  assert.deepEqual(parsed.procedureLines[0].denialCodes, ["CO-24", "CO-45", "PR-3"]);
  assert.equal(parsed.procedureLines[0].denialReasons[0], "24Charges are covered under a capitation agreement/managed care plan.");
  assert.equal(parsed.procedureLines[0].denialReasons[1], "45Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.");
  assert.equal(parsed.procedureLines[0].denialReasons[2], "3Co-payment Amount");
});
