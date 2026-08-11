import assert from "node:assert/strict";
import test from "node:test";
import { isExactWaystarPayerMatch, resolveWaystarSecurityAnswer } from "../portal";

test("matches verification-sheet answers using normalized question text", () => {
  const verificationAnswers = [
    { question: "What was the first car you owned?", answer: "Dzire" },
    { question: "Dessert", answer: "browine" },
    { question: "First Job", answer: "Biller" },
  ];

  assert.equal(resolveWaystarSecurityAnswer("What was the first car you owned?", verificationAnswers), "Dzire");
  assert.equal(resolveWaystarSecurityAnswer("what was the first car you owned", verificationAnswers), "Dzire");
  assert.equal(resolveWaystarSecurityAnswer("Dessert", verificationAnswers), "browine");
  assert.equal(resolveWaystarSecurityAnswer("What was your first job?", verificationAnswers), "Biller");
  assert.equal(resolveWaystarSecurityAnswer("Unknown question", verificationAnswers), null);
});

test("matches the Waystar Medicare payer when formatting differs but payer id is the same", () => {
  assert.equal(
    isExactWaystarPayerMatch(
      "Medicare A & B Eligibility (All States) (Z1073)",
      "Medicare A & B Eligibility (All States) (Z1073)",
    ),
    true,
  );
  assert.equal(
    isExactWaystarPayerMatch(
      "MEDICARE A AND B ELIGIBILITY - ALL STATES (Z1073)",
      "Medicare A & B Eligibility (All States) (Z1073)",
    ),
    true,
  );
  assert.equal(
    isExactWaystarPayerMatch(
      "AARP Medicare Supplement by UnitedHealthcare (36273)",
      "Medicare A & B Eligibility (All States) (Z1073)",
    ),
    false,
  );
});

test("matches the three-digit BCBS SB900 payer id", () => {
  assert.equal(
    isExactWaystarPayerMatch("Blue Cross Blue Shield Texas (SB900)", "BCBS Texas(SB900)"),
    true,
  );
  assert.equal(
    isExactWaystarPayerMatch("Blue Cross Blue Shield Florida (SB590)", "BCBS Texas(SB900)"),
    false,
  );
});
