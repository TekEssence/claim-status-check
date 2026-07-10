import assert from "node:assert/strict";
import test from "node:test";
import { blueShieldClaimExtractionTestHooks } from "../claim-extraction";

const {
  computeClaimStatus,
  formatClaimMessage,
  formatClaimNotesForLine,
  mergeServiceLineSources,
  noteForServiceLine,
  parseServiceLinesFromRows,
  parseServiceLinesFromText,
  sectionTextFromLines,
  sanitizeClaimNotesText,
  textMatchesRequestedDos,
} = blueShieldClaimExtractionTestHooks;

test("extracts the matching Blue Shield claim note for each service line", () => {
  const notes = "LINE 1 DENIED - not a covered benefit LINE 2 PAID per contracted rate";

  assert.equal(noteForServiceLine(notes, "1"), "Claim notes line 1: DENIED - not a covered benefit");
  assert.equal(noteForServiceLine(notes, "2"), "Claim notes line 2: PAID per contracted rate");
});

test("reports no Blue Shield claim notes for the matched service line", () => {
  assert.equal(
    noteForServiceLine("Claim notes: There are no notes for this claim.", "1"),
    "Claim notes line 1: There are no notes for line 1.",
  );
});

test("does not reuse another Blue Shield service line note for matched CPT line", () => {
  const notes = [
    "LINE 1",
    "CONTRACTING PHYSICIANS AND HEALTH CARE PROVIDERS AGREE TO ACCEPT THE ALLOWED AMOUNT AS PAYMENT IN FULL.",
  ].join(" ");

  assert.equal(
    noteForServiceLine(notes, "2"),
    "Claim notes line 2: There are no notes for line 2.",
  );
});

test("labels Blue Shield claim message text for Bot Claim Notes", () => {
  assert.equal(
    formatClaimMessage("THIS CLAIM HAS BEEN PAID BY CALPERS."),
    "Claim message: THIS CLAIM HAS BEEN PAID BY CALPERS.",
  );
});

test("labels Blue Shield claim notes with the matched line number", () => {
  assert.equal(
    formatClaimNotesForLine("PAID per contracted rate", "2"),
    "Claim notes line 2: PAID per contracted rate",
  );
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

test("computes Blue Shield pending status when service-line payment fields are dashes", () => {
  assert.equal(
    computeClaimStatus({
      detailAmountPaid: "",
      listAmountPaid: "",
      serviceLineAmountPaid: "-",
      serviceLineCoInsurance: "-",
      lineNotes: "",
      hasServiceLine: true,
    }),
    "Claim pending",
  );
});

test("removes Blue Shield site navigation text from claim notes", () => {
  assert.equal(
    sanitizeClaimNotesText([
      "Skip to content Contact us Site help Provider Connection Account Eligibility",
      "LINE 1 DENIED - MEMBER NOT ELIGIBLE ON DATE OF SERVICE",
      "Skip to content Contact us Site help Provider Connection Account Eligibility",
    ].join("\n")),
    "LINE 1 DENIED - MEMBER NOT ELIGIBLE ON DATE OF SERVICE",
  );
});

test("extracts Blue Shield claim message text before claim notes", () => {
  const claimMessage = sectionTextFromLines(
    [
      "Service and procedure details",
      "Claim message",
      "THIS CLAIM HAS BEEN PAID BY CALPERS.",
      "PLEASE REVIEW THE MEMBER RESPONSIBILITY ON THE EOB.",
      "Claim notes",
      "There are no notes for this claim.",
    ].join("\n"),
    /^claim\s+message$/i,
    /^(claim notes?|claim details|payment details|service and procedure details|service details|procedure details)$/i,
  );

  assert.equal(
    claimMessage,
    "THIS CLAIM HAS BEEN PAID BY CALPERS. PLEASE REVIEW THE MEMBER RESPONSIBILITY ON THE EOB.",
  );
});

test("allows Blue Shield result DOS ranges that contain the requested exact DOS", () => {
  assert.equal(
    textMatchesRequestedDos("09/07/2024-09/09/2024", new Set(["2024-09-08"])),
    true,
  );
  assert.equal(
    textMatchesRequestedDos("09/07/2024-09/09/2024", new Set(["2024-09-10"])),
    false,
  );
});
