import assert from "node:assert/strict";
import test from "node:test";
import { pickBestWaystarClaimCandidate } from "../portal";

test("picks the latest transaction date when duplicate claim rows have the same match score", () => {
  const selected = pickBestWaystarClaimCandidate([
    { id: "older", score: 7, transactionDateText: "02/02/2026" },
    { id: "latest", score: 7, transactionDateText: "03/30/2026" },
    { id: "middle", score: 7, transactionDateText: "03/01/2026" },
  ]);

  assert.equal(selected?.id, "latest");
});

test("keeps the stronger claim match even if another row has a newer transaction date", () => {
  const selected = pickBestWaystarClaimCandidate([
    { id: "best-match", score: 7, transactionDateText: "02/02/2026" },
    { id: "weaker-match", score: 5, transactionDateText: "05/30/2026" },
  ]);

  assert.equal(selected?.id, "best-match");
});


test("prefers the exact claim row when claim-number matching increases the score", () => {
  const selected = pickBestWaystarClaimCandidate([
    { id: "same-patient-wrong-claim", score: 5, transactionDateText: "05/30/2026" },
    { id: "exact-claim", score: 9, transactionDateText: "02/02/2026" },
  ]);

  assert.equal(selected?.id, "exact-claim");
});
