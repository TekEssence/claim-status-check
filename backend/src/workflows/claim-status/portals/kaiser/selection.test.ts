import assert from "node:assert/strict";
import test from "node:test";
import { matchKaiserName, selectKaiserCandidate, type SelectionCandidate } from "./selection";

const candidate = (claimNumber: string, status: string, changes: Partial<SelectionCandidate> = {}): SelectionCandidate => ({
  claimNumber, status, receivedDate: "09/03/2026", providerNpi: "1234567890", vendorTaxId: "987654321",
  provider: "Example Provider", vendor: "Example Vendor", patient: "Example, Jane A", dos: "05/29/2026", cpt: "99306", ...changes,
});

test("same-date Paid wins regardless of portal row ordering", () => {
  const denied = candidate("d", "Denied");
  const paid = candidate("p", "Paid");
  const progress = candidate("i", "In Progress");
  for (const rows of [[denied, paid, progress], [progress, denied, paid], [paid, progress, denied]]) {
    assert.equal(selectKaiserCandidate(rows).selected?.claimNumber, "p");
  }
});
test("same-date In Progress wins over denials", () => {
  assert.equal(selectKaiserCandidate([candidate("d", "Denied"), candidate("i", "In Progress"), candidate("old", "Denied", { receivedDate: "07/07/2026" })]).selected?.claimNumber, "i");
});
test("newest group precedes older paid claims", () => {
  assert.equal(selectKaiserCandidate([candidate("old", "Paid", { receivedDate: "08/01/2026" }), candidate("new", "Denied")]).selected?.claimNumber, "new");
});
test("equal preferred statuses require review", () => {
  assert.equal(selectKaiserCandidate([candidate("p1", "Paid"), candidate("p2", "Paid")]).selected, undefined);
});
test("different or missing provider/vendor/patient/CPT/DOS prevents ranking", () => {
  for (const changes of [{ providerNpi: "2222222222" }, { vendorTaxId: "" }, { vendor: "Different" }, { provider: "Other" }, { patient: "Other, Jane A" }, { cpt: "99307" }, { dos: "05/30/2026" }]) {
    assert.equal(selectKaiserCandidate([candidate("p", "Paid"), candidate("d", "Denied", changes)]).selected, undefined);
  }
});
test("unknown status is not silently treated as paid or denied", () => {
  assert.equal(selectKaiserCandidate([candidate("a", "Approved"), candidate("d", "Denied")]).selected, undefined);
});
test("missing and invalid received dates require review", () => {
  for (const receivedDate of ["", "02/30/2026", "unknown"]) {
    assert.equal(selectKaiserCandidate([candidate("p", "Paid"), candidate("d", "Denied", { receivedDate })]).selected, undefined);
  }
});
test("one verified claim preserves the single-result flow", () => {
  assert.equal(selectKaiserCandidate([candidate("p", "In Progress")]).selected?.claimNumber, "p");
  assert.equal(selectKaiserCandidate([]).selected, undefined);
});
test("normalization handles order, case, punctuation and missing middle names", () => {
  assert.equal(matchKaiserName("Example, Jane A", " jane a. EXAMPLE ", "123"), "exact");
  assert.equal(matchKaiserName("Example, Jane A", "Jane Example", "123"), "middle-name-variation");
  assert.equal(matchKaiserName("Example, Jane Alice", "Example, Jane A", "123"), "middle-name-variation");
});
test("only confirmed member-specific Don/Donald alias is accepted", () => {
  assert.equal(matchKaiserName("Atkinson, Donald A", "Atkinson, Don A", "000010213198"), "verified-alias");
  assert.equal(matchKaiserName("Atkinson, Donald A", "Atkinson, Don A", "different-member"), "review");
  assert.equal(matchKaiserName("Other, Donald A", "Other, Don A", "000010213198"), "review");
});
test("initial-only, first-name-only, conflicting names and arbitrary prefixes require review", () => {
  for (const [portal, input] of [
    ["Chabdi, Harshita", "Harshita C"], ["Chabdi, Harshita", "Harshita"],
    ["Example, Jane A", "Other, Jane A"], ["Example, Jane A", "Example, Jane B"],
    ["Example, Donald", "Example, Don"], ["Example, Jane", ""],
  ]) assert.equal(matchKaiserName(portal, input, "123"), "review");
});
