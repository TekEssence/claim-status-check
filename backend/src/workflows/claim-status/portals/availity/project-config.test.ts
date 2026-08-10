import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyProjectColumnMapping,
  applyProjectPreprocessing,
  getOrganizationForRow,
  getProviderOrderForRow,
  normalizeProjectId,
} from "./project-config";
import type { AvailityInputRow } from "./types";

function createRow(input_row_id: number, data: Record<string, string>): AvailityInputRow {
  return {
    input_row_id,
    source_row_number: input_row_id + 1,
    data: applyProjectColumnMapping("medrevenu", data),
  };
}

describe("applyProjectPreprocessing", () => {
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

describe("Charm project config", () => {
  it("normalizes Charm project id", () => {
    assert.equal(normalizeProjectId("Charm"), "charm");
  });

  it("maps Charm input columns to Availity common fields", () => {
    const mapped = applyProjectColumnMapping("charm", {
      "Invoice #": "INV-100",
      "Payer Name": "Payer [ 99726 ] - Tricare | West Region",
      "Patient Name": "DOE [ PAT13778 ], JANE",
      "Date Of Birth": "01/02/1980",
      "Insured's ID": "SUB-123",
      "Date Of Service": "06/16/2026",
      Charges: "$150.00",
      "Provider Name": "TEST PROVIDER",
      Group: "open mind",
    });

    assert.equal(mapped["Claim No"], "INV-100");
    assert.equal(mapped["Payer Name"], "Payer [ 99726 ] - Tricare | West Region");
    assert.equal(mapped["Patient Name"], "DOE, JANE");
    assert.equal(mapped["Patient DOB"], "01/02/1980");
    assert.equal(mapped["Subscriber No"], "SUB-123");
    assert.equal(mapped["Service Date"], "06/16/2026");
    assert.equal(mapped.Charges, "$150.00");
    assert.equal(mapped["Provider Name"], "TEST PROVIDER");
    assert.equal(mapped.Group, "open mind");
  });

  it("removes bracketed Charm patient ids from separate first and last name fields", () => {
    const mapped = applyProjectColumnMapping("charm", {
      "Patient first name": "JANE [ PAT13778 ]",
      "Patient last name": "CHARLENE [ PAT13778 ]",
    });

    assert.equal(mapped["Patient Name"], "JANE CHARLENE");
  });

  it("maps Charm group to Availity organization", () => {
    const row: AvailityInputRow = {
      input_row_id: 1,
      source_row_number: 2,
      data: applyProjectColumnMapping("charm", {
        Group: "Open Mind",
      }),
    };

    assert.equal(getOrganizationForRow("charm", row), "Open Mind Health");
  });

  it("keeps Minimax and Medrevenu organization blank", () => {
    const row: AvailityInputRow = {
      input_row_id: 1,
      source_row_number: 2,
      data: { Group: "open mind" },
    };

    assert.equal(getOrganizationForRow("minimax", row), undefined);
    assert.equal(getOrganizationForRow("medrevenu", row), undefined);
  });

  it("uses Charm provider mapping first and input provider as fallback", () => {
    const row: AvailityInputRow = {
      input_row_id: 1,
      source_row_number: 2,
      data: applyProjectColumnMapping("charm", {
        Group: "open mind",
        "Provider Name": "INPUT PROVIDER",
      }),
    };

    assert.deepEqual(getProviderOrderForRow("charm", row, [{
      active: true,
      project: "charm",
      group: "open mind",
      providerName: "MAPPED PROVIDER",
    }]), ["MAPPED PROVIDER", "INPUT PROVIDER"]);
  });

  it("falls back to Charm input provider when provider mapping is missing", () => {
    const row: AvailityInputRow = {
      input_row_id: 1,
      source_row_number: 2,
      data: applyProjectColumnMapping("charm", {
        Group: "open mind",
        "Provider Name": "INPUT PROVIDER",
      }),
    };

    assert.deepEqual(getProviderOrderForRow("charm", row, []), ["INPUT PROVIDER"]);
  });

  it("cleans bracketed Charm input provider before using provider fallback", () => {
    const row: AvailityInputRow = {
      input_row_id: 1,
      source_row_number: 2,
      data: applyProjectColumnMapping("charm", {
        Group: "open mind",
        "Provider Name": "Jane Charlene [ abcd",
      }),
    };

    assert.deepEqual(getProviderOrderForRow("charm", row, []), ["Jane Charlene"]);
  });
});
