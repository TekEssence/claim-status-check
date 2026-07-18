import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyProjectOutputStrategy } from "./project-output";
import type { AvailityInputRow, AvailityOutputRow } from "./types";

function createInputRow(data: Record<string, string>): AvailityInputRow {
  return {
    input_row_id: 1,
    source_row_number: 2,
    data,
  };
}

function createOutputRow(row: AvailityInputRow): AvailityOutputRow {
  return {
    input_row_id: row.input_row_id,
    ...row.data,
    bot_updated_claim_status: "",
    bot_updated_time: "",
    bot_search_source_tab: "",
    bot_match_count: "",
    bot_overall_result: "",
    bot_notes: "",
  };
}

describe("applyProjectOutputStrategy", () => {
  it("keeps Minimax claim-level summary unchanged", () => {
    const row = createInputRow({ CPT: "99214" });
    const [outputRow] = applyProjectOutputStrategy({
      projectId: "minimax",
      row,
      outputRow: createOutputRow(row),
      timestamp: "2026-07-15T00:00:00.000Z",
      result: {
        status: "success",
        summaries: ["claim level summary"],
        sourceTab: "HIPAA Standard",
        matchCount: 1,
      },
    });

    assert.equal(outputRow.bot_updated_claim_status, "claim level summary");
    assert.equal(outputRow.bot_overall_result, "success");
  });

  it("formats only the matching Medrevenu CPT line", () => {
    const row = createInputRow({ CPT: "99214" });
    const [outputRow] = applyProjectOutputStrategy({
      projectId: "medrevenu",
      row,
      outputRow: createOutputRow(row),
      timestamp: "2026-07-15T00:00:00.000Z",
      result: {
        status: "success",
        summaries: ["claim level summary"],
        sourceTab: "Service Dates",
        matchCount: 1,
        details: [{
          type: "paid",
          serviceDate: "06/09/2026",
          finalizedDate: "06/18/2026",
          receivedDate: "06/10/2026",
          claimNumber: "320357178700",
          checkNumber: "1005020411",
          checkDate: "06/30/2026",
          checkAmount: "$50.00",
          lines: [
            { procedureCode: "G8427", paid: "$0.00" },
            { procedureCode: "99214", paid: "$25.00", billed: "$150.00", allowed: "$130.54", copay: "$5.00", coinsurance: "$10.00", deductible: "$0.00" },
          ],
        }],
      },
    });

    assert.match(String(outputRow.bot_updated_claim_status), /CPT 99214/);
    assert.match(String(outputRow.bot_updated_claim_status), /claim received on 06\/10\/2026/);
    assert.doesNotMatch(String(outputRow.bot_updated_claim_status), /claim received on 06\/18\/2026/);
    assert.match(String(outputRow.bot_updated_claim_status), /paid on 06\/30\/2026/);
    assert.doesNotMatch(String(outputRow.bot_updated_claim_status), /paid on 06\/18\/2026/);
    assert.match(String(outputRow.bot_updated_claim_status), /paid amount \$25\.00/);
    assert.match(String(outputRow.bot_updated_claim_status), /copay of \$5\.00, coinsurance of \$10\.00, and deductible of \$0\.00/);
    assert.match(String(outputRow.bot_updated_claim_status), /Check Amount: \$50\.00/);
    assert.match(String(outputRow.bot_updated_claim_status), /Allowed Amount: \$130\.54/);
    assert.doesNotMatch(String(outputRow.bot_updated_claim_status), /G8427/);
  });

  it("marks Medrevenu row failed when input CPT is not in extracted lines", () => {
    const row = createInputRow({ CPT: "99214" });
    const [outputRow] = applyProjectOutputStrategy({
      projectId: "medrevenu",
      row,
      outputRow: createOutputRow(row),
      timestamp: "2026-07-15T00:00:00.000Z",
      result: {
        status: "success",
        summaries: ["claim level summary"],
        details: [{ type: "paid", lines: [{ procedureCode: "G8427", paid: "$0.00" }] }],
      },
    });

    assert.equal(outputRow.bot_overall_result, "failed");
    assert.match(String(outputRow.bot_notes), /CPT 99214 was not found/);
  });

  it("uses readable and separator for multiple Medrevenu denial descriptions", () => {
    const row = createInputRow({ CPT: "99204" });
    const [outputRow] = applyProjectOutputStrategy({
      projectId: "medrevenu",
      row,
      outputRow: createOutputRow(row),
      timestamp: "2026-07-15T00:00:00.000Z",
      result: {
        status: "success",
        summaries: ["claim level summary"],
        details: [{
          type: "denied",
          serviceDate: "05/27/2025",
          finalizedDate: "03/11/2026",
          receivedDate: "03/10/2026",
          checkDate: "03/12/2026",
          claimNumber: "2026070DI9751",
          lines: [{
            procedureCode: "99204",
            remarkCode: "29, 00312",
            description: "29: The time limit for filing has expired. | 00312: This was denied because it was received after the claim timely filing limit.",
          }],
        }],
      },
    });

    assert.match(String(outputRow.bot_updated_claim_status), /claim received on 03\/10\/2026 denied on 03\/12\/2026/);
    assert.match(String(outputRow.bot_updated_claim_status), /expired\. and 00312:/);
    assert.doesNotMatch(String(outputRow.bot_updated_claim_status), /\|/);
  });
});
