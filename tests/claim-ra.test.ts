import test from "node:test";
import assert from "node:assert/strict";
import {
  getClaimCptValue,
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

  assert.equal(records.length, 2);
  assert.equal(records[0].RAProcCode, "99213");
  assert.equal(records[0].RAAmountBilled, "280.00");
  assert.equal(records[0].RAAmountAllowed, "105.22");
  assert.equal(records[0].RACopay, "0.00");
  assert.equal(records[0].RACoins, "0.00");
  assert.equal(records[0].RADeductAmount, "0.00");
  assert.equal(records[0].RANetPaid, "0.00");
  assert.equal(records[0].RAStatus, "Denied");
  assert.equal(records[0].RAReason, "A1");
  assert.equal(
    records[0].RADenialReason,
    "A1 - Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.",
  );
  assert.equal(records[1].RAReason, "AUTHD");
  assert.equal(records[1].RADenialReason, "AUTHD - AUTHD - Precertification/authorization/notification absent");
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

  assert.deepEqual(records.map((record) => record.RAReason), ["59", "001167", "119", "N362"]);
  assert.equal(records[0].RAStatus, "Paid");
  assert.equal(records[0].RAAmountBilled, "2,010.00");
  assert.equal(records[3].RADenialReason, "N362 - The number of days or units of service exceeds acceptable maximum.");
});
