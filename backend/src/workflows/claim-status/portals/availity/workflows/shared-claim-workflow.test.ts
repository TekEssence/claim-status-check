import assert from "node:assert/strict";
import { describe, it } from "node:test";
import sharedClaimWorkflow from "./shared-claim-workflow.js";

const { processParsedSearchResults } = sharedClaimWorkflow;

function resultRow(billedAmount: string) {
  return {
    index: 0,
    serviceDate: "07/21/2026",
    billedAmount,
    patientId: "",
    patientName: "ARZATE, MARISELA",
    finalizedDate: "08/11/2026",
    finalizedDateValue: new Date("2026-08-11"),
    claimNumber: "EBY2YJ9H600",
    status: { type: "unsupported", display: "PAID" },
  };
}

const inputRow = {
  data: {
    "Service Date": "07/21/2026",
    Charges: "3987.00",
    "Payer Name": "Aetna",
  },
};

describe("Availity shared result matching", () => {
  it("ignores billed amount when the project matching policy disables it", async () => {
    const result = await processParsedSearchResults(
      {},
      inputRow,
      "TEST PROVIDER",
      { total: 1 },
      "HIPAA Standard",
      [resultRow("$1,329.00")],
      "failed",
      { matchingPolicy: { matchBilledAmount: false } },
    );

    assert.equal(result.status, "success");
    assert.equal(result.matchCount, 1);
    assert.match(result.matchDetails, /Service Date/);
    assert.doesNotMatch(result.matchDetails, /Service Date \+ Charges/);
  });

  it("continues matching billed amount when the policy enables it", async () => {
    const result = await processParsedSearchResults(
      {},
      inputRow,
      "TEST PROVIDER",
      { total: 1 },
      "HIPAA Standard",
      [resultRow("$1,329.00")],
      "failed",
      { matchingPolicy: { matchBilledAmount: true } },
    );

    assert.equal(result.status, "failed");
    assert.equal(result.matchCount, 0);
    assert.match(result.notes, /Service Date \+ Charges/);
  });
});
