import test from "node:test";
import assert from "node:assert/strict";
import {
  describeRaMatchFailureFromText,
  getClaimCptValue,
  getClaimModifierValues,
  parseRaDetailsFromText,
} from "../lib/claim-ra";
import { parseDateInput } from "../lib/claim-dates";

test("finds CPT through common procedure column aliases", () => {
  assert.equal(getClaimCptValue({ cpt: "99213" }), "99213");
  assert.equal(getClaimCptValue({ "Proc Code": "99214" }), "99214");
  assert.equal(getClaimCptValue({ "CPT Code": "99215" }), "99215");
  assert.equal(getClaimCptValue({ "procedure code": "99216" }), "99216");
  assert.equal(getClaimCptValue({ "Member ID": "abc" }), "");
});

test("finds modifiers through common modifier column aliases", () => {
  assert.deepEqual(getClaimModifierValues({ Mod: "RT" }), ["RT"]);
  assert.deepEqual(getClaimModifierValues({ "Modifier 1": "78", "Modifier 2": "RT" }), ["78", "RT"]);
  assert.deepEqual(getClaimModifierValues({ mod1: "78 RT", mod2: "LT" }), ["78", "RT", "LT"]);
});

test("parses RA detail lines, maps status, splits reasons, and expands denial descriptions", () => {
  const dosDate = parseDateInput("01/30/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "40000336447080 Medi-Cal ABCDE, FGHIJ KMLN OPQR",
    "0126368112 001006 04/22/2026 01/30/2026 01/30/2026 99213 24 1.00 280.00 105.22 105.22 0.00 0.00 0.00 0.00 D A1 AUTHD",
    "Explanation Code Legend",
    "A1 Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.",
    "AUTHD AUTHD - Precertification/authorization/notification absent",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "40000336447080",
    dosDate,
    cpt: "99213",
    checkNumber: "123456",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].RAProcCode, "99213");
  assert.equal(records[0].RAAmountBilled, "280.00");
  assert.equal(records[0].RAAmountAllowed, "105.22");
  assert.equal(records[0].RACopay, "0.00");
  assert.equal(records[0].RACoins, "0.00");
  assert.equal(records[0].RADeductAmount, "0.00");
  assert.equal(records[0].RANetPaid, "0.00");
  assert.equal(records[0].RAStatus, "Denied");
  assert.equal(records[0].RAReason, "A1, AUTHD");
  assert.equal(
    records[0].RADenialReason,
    "A1 - Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement., AUTHD - AUTHD - Precertification/authorization/notification absent",
  );
});

test("keeps wrapped RA reason continuation lines with the correct service line", () => {
  const dosDate = parseDateInput("05/01/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "40000336447080 Medi-Cal ABCDE, FGHIJ KMLN OPQR",
    "1 05/14/2026 05/01/2026 05/01/2026 19301 RT 1 $2,010.00 $679.34 $0.00 $0.00 $0.00 $0.00 $679.34 $0.00 P 59 001167",
    "119 N362",
    "2 05/14/2026 05/01/2026 05/01/2026 38525 51 RT 1 $1,350.00 $232.30 $0.00 $0.00 $0.00 $0.00 $232.30 $0.00 P 59 001167",
    "119 N362",
    "004839",
    "Explanation Code Legend",
    "59 Processed based on multiple procedure rules.",
    "001167 Contract pricing applied.",
    "119 Benefit maximum for this service has been reached.",
    "N362 The number of days or units of service exceeds acceptable maximum.",
    "004839 Claim adjusted per payment policy.",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "40000336447080",
    dosDate,
    cpt: "19301",
    checkNumber: "123456",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].RAReason, "59, 001167, 119, N362");
  assert.equal(records[0].RAStatus, "Paid");
  assert.equal(records[0].RAAmountBilled, "2,010.00");
  assert.equal(
    records[0].RADenialReason,
    "59 - Processed based on multiple procedure rules., 001167 - Contract pricing applied., 119 - Benefit maximum for this service has been reached., N362 - The number of days or units of service exceeds acceptable maximum.",
  );
});

test("matches dashed member ids and scans all member sections before deciding", () => {
  const dosDate = parseDateInput("01/30/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "1111111111-11 Medi-Cal OTHER, MEMBER TEST PROVIDER",
    "0126368112 001006 04/22/2026 01/30/2026 01/30/2026 99213 24 1.00 280.00 100.00 100.00 0.00 0.00 0.00 0.00 D A1",
    "8749274028-00 Medi-Cal TARGET, MEMBER TEST PROVIDER",
    "0126368112 001006 04/22/2026 01/30/2026 01/30/2026 99213 24 1.00 280.00 105.22 105.22 0.00 0.00 0.00 0.00 D AUTHD",
    "Explanation Code Legend",
    "A1 Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.",
    "AUTHD AUTHD - Precertification/authorization/notification absent",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "874927402800",
    dosDate,
    cpt: "99213",
    checkNumber: "123456",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].RAReason, "AUTHD");
  assert.equal(records[0].RAAmountAllowed, "105.22");
});

test("matches 10-digit member ids against 8-2 dashed covered-ra style ids", () => {
  const dosDate = parseDateInput("01/30/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 Medi-Cal TARGET, MEMBER TEST PROVIDER",
    "0126368112 001006 04/22/2026 01/30/2026 01/30/2026 99213 24 1.00 280.00 105.22 105.22 0.00 0.00 0.00 0.00 D AUTHD",
    "Explanation Code Legend",
    "AUTHD AUTHD - Precertification/authorization/notification absent",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate,
    cpt: "99213",
    checkNumber: "123456",
    preferLastTwoDashedMemberId: true,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].RAReason, "AUTHD");
});

test("matches generalized covered-ra dashed member ids using all-but-last-2 format", () => {
  const dosDate = parseDateInput("01/30/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "400003364470-80 Medi-Cal TARGET, MEMBER TEST PROVIDER",
    "0126368112 001006 04/22/2026 01/30/2026 01/30/2026 99213 24 1.00 280.00 105.22 105.22 0.00 0.00 0.00 0.00 D AUTHD",
    "Explanation Code Legend",
    "AUTHD AUTHD - Precertification/authorization/notification absent",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "40000336447080",
    dosDate,
    cpt: "99213",
    checkNumber: "123456",
    preferLastTwoDashedMemberId: true,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].RAReason, "AUTHD");
});

test("matches RA line when any one excel modifier matches the pdf line modifiers", () => {
  const dosDate = parseDateInput("05/01/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "40000336447080 Medi-Cal ABCDE, FGHIJ KMLN OPQR",
    "1 05/14/2026 05/01/2026 05/01/2026 38525 51 RT 1 $1,350.00 $232.30 $0.00 $0.00 $0.00 $0.00 $232.30 $0.00 P 59",
    "Explanation Code Legend",
    "59 Processed based on multiple procedure rules.",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "40000336447080",
    dosDate,
    cpt: "38525",
    modifiers: ["78", "RT"],
    checkNumber: "123456",
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].RAProcCode, "38525");
  assert.equal(records[0].RAStatus, "Paid");
});

test("matches DOS against Service From/To columns instead of any date on the line", () => {
  const dosDate = parseDateInput("04/13/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026 21552 1 $1,375.00 $463.83 $0.00 $0.00 $0.00 $0.00 $463.83 $0.00 P",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate,
    cpt: "21552",
    checkNumber: "181393",
    preferLastTwoDashedMemberId: true,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].RAProcCode, "21552");
  assert.equal(records[0].RAStatus, "Paid");
});

test("treats claim number plus line/ver plus 3 continuous dates as a structured RA line", () => {
  const dosDate = parseDateInput("04/13/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered Julian Gutierrez Gustavo Lara",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026 21552 1 $1,375.00 $463.83 $0.00 $0.00 $139.15 $0.00 $324.68 $139.15 P 2 001167 004839 $0.00",
    "Explanation Code Legend",
    "2 Coinsurance amount.",
    "001167 Contract pricing applied.",
    "004839 Claim adjusted per payment policy.",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate,
    cpt: "21552",
    checkNumber: "181393",
    preferLastTwoDashedMemberId: true,
  });

  assert.equal(records.length, 1);
  assert.equal(records[0].RAProcCode, "21552");
  assert.equal(records[0].RAStatus, "Paid");
});

test("matches covered-ra member ids even when spaces appear around the dash", () => {
  const dosDate = parseDateInput("04/13/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400 - 00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026 21552 1 $1,375.00 $463.83 $0.00 $0.00 $0.00 $0.00 $463.83 $0.00 P",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate,
    cpt: "21552",
    checkNumber: "181393",
    preferLastTwoDashedMemberId: true,
  });

  assert.equal(records.length, 1);
});

test("describes found service dates, proc, and modifiers when no RA line matches", () => {
  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026 21552 RT 1 $1,375.00 $463.83 $0.00 $0.00 $0.00 $0.00 $463.83 $0.00 P",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const description = describeRaMatchFailureFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate: parseDateInput("05/01/2026")!,
    cpt: "21552",
    modifiers: ["LT"],
    preferLastTwoDashedMemberId: true,
  });

  assert.match(description, /DOS 05\/01\/2026 not found/);
  assert.match(description, /Available DOS: 04\/13\/2026/);
});

test("describes available CPT when DOS matches but cpt does not", () => {
  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026 21552 RT 1 $1,375.00 $463.83 $0.00 $0.00 $0.00 $0.00 $463.83 $0.00 P",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const description = describeRaMatchFailureFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate: parseDateInput("04/13/2026")!,
    cpt: "99999",
    preferLastTwoDashedMemberId: true,
  });

  assert.match(description, /CPT 99999 not found/);
  assert.match(description, /Available CPT: 21552/);
});

test("describes available modifiers when member, dos, and cpt match but modifier does not", () => {
  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026 21552 RT 1 $1,375.00 $463.83 $0.00 $0.00 $0.00 $0.00 $463.83 $0.00 P",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const description = describeRaMatchFailureFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate: parseDateInput("04/13/2026")!,
    cpt: "21552",
    modifiers: ["LT"],
    preferLastTwoDashedMemberId: true,
  });

  assert.match(description, /modifiers LT not found/);
  assert.match(description, /Available modifiers: RT/);
});

test("describes DOS/CPT from member section even when amount columns are incomplete", () => {
  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026 21552 RT 1",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const description = describeRaMatchFailureFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate: parseDateInput("05/01/2026")!,
    cpt: "21552",
    preferLastTwoDashedMemberId: true,
  });

  assert.match(description, /DOS 05\/01\/2026 not found/);
  assert.match(description, /Available DOS: 04\/13\/2026/);
});

test("lists available member ids when target member is not found", () => {
  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "8749274028-00 IEHP Covered OTHER, MEMBER TEST PROVIDER",
    "ST Code Legend: P Payable, D Denied, E Encounter",
  ].join("\n");

  const description = describeRaMatchFailureFromText({
    text,
    memberPolicyId: "1111111111",
    preferLastTwoDashedMemberId: true,
  });

  assert.match(description, /Claim\/member not found/);
  assert.match(description, /Available member IDs: 70209400-00, 8749274028-00/);
});

test("scans member section lines until totals instead of only a small fixed window", () => {
  const dosDate = parseDateInput("04/13/2026");
  assert.ok(dosDate);

  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "Patient Acct. # 4090/123647",
    "Some wrapped text",
    "Another wrapped text",
    "More text",
    "Still same member section",
    "Yet another line",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026 21552 1 $1,375.00 $463.83 $0.00 $0.00 $139.15 $0.00 $324.68 $139.15 P 2 001167 004839 $0.00",
    "Member Totals : 1375.00 463.83 324.68",
  ].join("\n");

  const records = parseRaDetailsFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate,
    cpt: "21552",
    checkNumber: "181393",
    preferLastTwoDashedMemberId: true,
  });

  assert.equal(records.length, 1);
});

test("prints immediate below line with parsed and not parsed pieces when no structured line is found", () => {
  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026",
    "Member Totals : 1375.00 463.83 324.68",
  ].join("\n");

  const description = describeRaMatchFailureFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate: parseDateInput("04/13/2026")!,
    cpt: "21552",
    preferLastTwoDashedMemberId: true,
  });

  assert.match(description, /Member line: 70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER/);
  assert.match(description, /Immediate below line: P202615601413 1 06\/05\/2026 04\/13\/2026 04\/13\/2026/);
  assert.match(description, /Parsed: Claim P202615601413, Received 06\/05\/2026, Service From 04\/13\/2026, Service To 04\/13\/2026/);
  assert.match(description, /Not parsed: proc code after dates/);
});

test("keeps immediate below line for debug when the first line is not proper", () => {
  const text = [
    "Member # Line of Business Patient Name Provider Name",
    "70209400-00 IEHP Covered TARGET, MEMBER TEST PROVIDER",
    "noise only",
    "P202615601413 1 06/05/2026 04/13/2026 04/13/2026",
    "Member Totals : 1375.00 463.83 324.68",
  ].join("\n");

  const description = describeRaMatchFailureFromText({
    text,
    memberPolicyId: "7020940000",
    dosDate: parseDateInput("04/13/2026")!,
    cpt: "21552",
    preferLastTwoDashedMemberId: true,
  });

  assert.match(description, /Immediate below line: noise only/);
  assert.match(description, /Parsed: \(nothing\)/);
});
