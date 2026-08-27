import assert from "node:assert/strict";
import test from "node:test";
import type { PaymentEobComparisonRow, PaymentEobPortalRecord, PaymentTrackerRow } from "../../types";
import { addPaymentTrackerRow } from "./tracker";

const record: PaymentEobPortalRecord = {
  checkNumber: "0900562787",
  checkDate: "07/15/2026",
  payer: "ARKANSAS TOTAL CARE",
  payee: "BENTONVILLE PEDIATRICS",
  receivedByAvaility: "07/15/2026",
  amount: "$39.26",
  raw: {},
};

function result(overrides: Partial<PaymentEobComparisonRow> = {}): PaymentEobComparisonRow {
  return {
    checkNumber: record.checkNumber,
    checkDate: record.checkDate,
    comparison: "Unique",
    searchResult: "Found",
    pdfStatus: "Downloaded",
    filename: "0900562787_2026-07-15.pdf",
    message: "Success",
    ...overrides,
  };
}

test("tracks a successful Availity PDF once with mapped portal values", () => {
  const rows: PaymentTrackerRow[] = [];
  const seen = new Set<string>();
  addPaymentTrackerRow(rows, seen, record, result(), "08/27/2026");
  addPaymentTrackerRow(rows, seen, record, result(), "08/27/2026");

  assert.deepEqual(rows, [{
    source: "Availity",
    eraDownloadedDate: "08/27/2026",
    payerName: "ARKANSAS TOTAL CARE",
    payeeName: "BENTONVILLE PEDIATRICS",
    checkNumber: "0900562787",
    checkDate: "07/15/2026",
    checkAmount: "$39.26",
  }]);
});

test("does not track skipped, not-found, or failed PDFs", () => {
  const rows: PaymentTrackerRow[] = [];
  const seen = new Set<string>();
  addPaymentTrackerRow(rows, seen, record, result({ comparison: "Existing", searchResult: "Skipped", pdfStatus: "Skipped" }), "08/27/2026");
  addPaymentTrackerRow(rows, seen, record, result({ searchResult: "Not found", pdfStatus: "Not downloaded" }), "08/27/2026");
  addPaymentTrackerRow(rows, seen, record, result({ searchResult: "Error", pdfStatus: "Error" }), "08/27/2026");
  assert.deepEqual(rows, []);
});
