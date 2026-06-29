import assert from "node:assert/strict";
import test from "node:test";
import { blueShieldClaimExtractionTestHooks } from "../claim-extraction";

const {
  computeClaimStatus,
  mergeServiceLineSources,
  noteForServiceLine,
  parseServiceLinesFromRows,
  parseServiceLinesFromText,
} = blueShieldClaimExtractionTestHooks;

test("extracts the matching Blue Shield claim note for each service line", () => {
  const notes = "LINE 1 DENIED - not a covered benefit LINE 2 PAID per contracted rate";

  assert.equal(noteForServiceLine(notes, "1"), "DENIED - not a covered benefit");
  assert.equal(noteForServiceLine(notes, "2"), "PAID per contracted rate");
});

test("computes Blue Shield status from service-line data before claim-level totals", () => {
  assert.equal(
    computeClaimStatus({
      detailAmountPaid: "$100.00",
      listAmountPaid: "$100.00",
      serviceLineAmountPaid: "$0.00",
      serviceLineCoInsurance: "",
      lineNotes: "DENIED - not a covered benefit",
      hasServiceLine: true,
    }),
    "Denied",
  );

  assert.equal(
    computeClaimStatus({
      detailAmountPaid: "$100.00",
      listAmountPaid: "$100.00",
      serviceLineAmountPaid: "$25.00",
      serviceLineCoInsurance: "",
      lineNotes: "",
      hasServiceLine: true,
    }),
    "Paid",
  );
});

test("parses every Blue Shield service line from the claim detail table", () => {
  const lines = parseServiceLinesFromRows(
    [
      "Line #",
      "Dates of service",
      "Place of service",
      "Units",
      "Procedure code",
      "Modifier",
      "Amount billed",
      "Allowed amount",
      "Deductible",
      "Copay",
      "Co-Insurance",
      "Amount paid",
    ],
    [
      ["1", "04/18/2026-04/18/2026", "Office", "1", "99214", "N/A", "$330.00", "$113.27", "$0.00", "$35.00", "$0.00", "$78.27"],
      ["2", "04/18/2026-04/18/2026", "Office", "1", "99051", "N/A", "$60.00", "$0.00", "$0.00", "$0.00", "$0.00", "$0.00"],
      ["3", "04/18/2026-04/18/2026", "Office", "1", "A4550", "N/A", "$20.00", "$5.00", "$0.00", "$0.00", "$0.00", "$5.00"],
    ],
  );

  assert.equal(lines.length, 3);
  assert.deepEqual(
    lines.map((line) => [line.lineNumber, line.procedureCode, line.amountPaid]),
    [
      ["1", "99214", "$78.27"],
      ["2", "99051", "$0.00"],
      ["3", "A4550", "$5.00"],
    ],
  );
});

test("falls back to parsing multiple service lines from copied page text", () => {
  const lines = parseServiceLinesFromText([
    "Service and procedure details",
    "Line # Dates of service Place of service Units Procedure code Modifier Amount billed Allowed amount Deductible Copay Co-Insurance Amount paid",
    "1 04/18/2026-04/18/2026 Office 1 99214 N/A $330.00 $113.27 $0.00 $35.00 $0.00 $78.27",
    "2 04/18/2026-04/18/2026 Office 1 99051 N/A $60.00 $0.00 $0.00 $0.00 $0.00 $0.00",
  ].join("\n"));

  assert.equal(lines.length, 2);
  assert.equal(lines[1].lineNumber, "2");
  assert.equal(lines[1].procedureCode, "99051");
  assert.equal(lines[1].amountPaid, "$0.00");
});

test("falls back when Blue Shield service grid text is split cell by cell", () => {
  const lines = parseServiceLinesFromText([
    "Service and procedure details",
    "Line #",
    "Dates of",
    "service",
    "Place of",
    "service",
    "Units",
    "Procedure",
    "code",
    "Modifier",
    "Amount",
    "billed",
    "Allowed",
    "amount",
    "Deductible",
    "Copay",
    "Co-Insurance",
    "Amount",
    "paid",
    "1",
    "04/18/2026-",
    "04/18/2026",
    "Office",
    "1",
    "99214",
    "N/A",
    "$330.00",
    "$113.27",
    "$0.00",
    "$35.00",
    "$0.00",
    "$78.27",
    "2",
    "04/18/2026-",
    "04/18/2026",
    "Office",
    "1",
    "99051",
    "N/A",
    "$60.00",
    "$0.00",
    "$0.00",
    "$0.00",
    "$0.00",
    "$0.00",
    "Claim message",
    "THIS CLAIM HAS BEEN PAID BY CALPERS.",
    "Claim notes",
  ].join("\n"));

  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map((line) => [line.lineNumber, line.datesOfService, line.procedureCode, line.amountPaid]),
    [
      ["1", "04/18/2026-04/18/2026", "99214", "$78.27"],
      ["2", "04/18/2026-04/18/2026", "99051", "$0.00"],
    ],
  );
});

test("merges service-line sources and keeps both clean Blue Shield lines", () => {
  const malformedGridLine = parseServiceLinesFromRows(
    [
      "Line #",
      "Dates of service",
      "Place of service",
      "Units",
      "Procedure code",
      "Modifier",
      "Amount billed",
      "Allowed amount",
      "Deductible",
      "Copay",
      "Co-Insurance",
      "Amount paid",
    ],
    [
      [
        "2",
        "04/18/2026-04/18/2026",
        "Office",
        "1",
        "99051",
        "N/A",
        "2 04/18/2026-04/18/2026 Office 1 99051 N/A $60.00 $0.00 $0.00 $0.00 $0.00 $0.00-$60.00",
        "$0.00",
        "$0.00",
        "$0.00",
        "$0.00",
        "$0.00",
      ],
    ],
  );
  const cleanTextLines = parseServiceLinesFromText([
    "Service and procedure details",
    "1 04/18/2026-04/18/2026 Office 1 99214 N/A $330.00 $113.27 $0.00 $35.00 $0.00 $78.27",
    "2 04/18/2026-04/18/2026 Office 1 99051 N/A $60.00 $0.00 $0.00 $0.00 $0.00 $0.00",
  ].join("\n"));

  const lines = mergeServiceLineSources([malformedGridLine, cleanTextLines]);

  assert.deepEqual(
    lines.map((line) => [line.lineNumber, line.procedureCode, line.amountBilled, line.amountPaid]),
    [
      ["1", "99214", "$330.00", "$78.27"],
      ["2", "99051", "$60.00", "$0.00"],
    ],
  );
});
