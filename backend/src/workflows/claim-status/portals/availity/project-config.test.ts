import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyProjectColumnMapping, applyProjectPreprocessing } from "./project-config";
import type { AvailityInputRow } from "./types";

function createRow(input_row_id: number, data: Record<string, string>): AvailityInputRow {
  return {
    input_row_id,
    source_row_number: input_row_id + 1,
    data: applyProjectColumnMapping("medrevenu", data),
  };
}

describe("applyProjectPreprocessing", () => {
  it("maps Medrevenu DOB column to Patient DOB", () => {
    const row = createRow(1, {
      DOB: "01/15/1980",
    });

    assert.equal(row.data["Patient DOB"], "01/15/1980");
  });

  it("sums Medrevenu CPT-level billed amounts by account number and episode dos", () => {
    const rows = [
      createRow(1, {
        "Responsible Payer": "Molina",
        DOS: "03/19/2026",
        "Billed Amount": "$1,000.00",
        "Account Number": "ACC-1",
        Episode_DOS: "1",
      }),
      createRow(2, {
        "Responsible Payer": "Molina",
        DOS: "03/19/2026",
        "Billed Amount": "2500",
        "Account Number": "ACC-1",
        Episode_DOS: "1",
      }),
      createRow(3, {
        "Responsible Payer": "Molina",
        DOS: "03/19/2026",
        "Billed Amount": "125",
        "Account Number": "ACC-2",
        Episode_DOS: "1",
      }),
    ];

    const processed = applyProjectPreprocessing("medrevenu", rows);

    assert.equal(processed[0].data.Charges, "3500.00");
    assert.equal(processed[1].data.Charges, "3500.00");
    assert.equal(processed[2].data.Charges, "125.00");
    assert.equal(processed[0].data["Line Billed Amount"], "$1,000.00");
    assert.equal(processed[1].data["Line Billed Amount"], "2500");
  });

  it("handles date-like episode dos values as grouping text", () => {
    const rows = [
      createRow(1, {
        "Billed Amount": "100.10",
        "Account Number": "ACC-1",
        Episode_DOS: "03/19/2026",
      }),
      createRow(2, {
        "Billed Amount": "200.20",
        "Account Number": "ACC-1",
        Episode_DOS: "03/19/2026",
      }),
    ];

    const processed = applyProjectPreprocessing("medrevenu", rows);

    assert.equal(processed[0].data.Charges, "300.30");
    assert.equal(processed[1].data.Charges, "300.30");
  });

  it("does not change non-Medrevenu rows", () => {
    const rows: AvailityInputRow[] = [{
      input_row_id: 1,
      source_row_number: 2,
      data: {
        Charges: "100",
        "Billed Amount": "200",
        "Account Number": "ACC-1",
        Episode_DOS: "1",
      },
    }];

    assert.equal(applyProjectPreprocessing("minimax", rows), rows);
  });
});
