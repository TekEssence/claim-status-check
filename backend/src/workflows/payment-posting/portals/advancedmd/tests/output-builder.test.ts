import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  assertPaymentPostingActionAllowed,
  buildPaymentPostingScreenshotFilename,
  createBaseResultRow,
  decidePaymentPostingStatus,
} from "../../../base";
import { createPaymentPostingOutputWorkbookBuffer, PAYMENT_POSTING_OUTPUT_COLUMNS } from "../output-builder";
import type { PaymentPostingInputRow } from "../../../types";

function inputRow(overrides: Partial<PaymentPostingInputRow> = {}): PaymentPostingInputRow {
  return {
    inputRow: 2,
    checkNumber: "12/34:56",
    payerName: "Aetna",
    carrier: "Aetna",
    checkAmount: "$100.00",
    checkDate: "01/02/2026",
    patientName: "Jane Doe",
    patientId: "0007",
    patientControlNumber: "PCN-1",
    visitClaimNumber: "",
    visitDateDos: "01/01/2026",
    cpt: "99213",
    chargeAmount: "120",
    paymentAmount: "80",
    raw: { "Check #": "12/34:56" },
    validationErrors: [],
    ...overrides,
  };
}

test("builds safe screenshot filenames with not_posted marker", () => {
  const filename = buildPaymentPostingScreenshotFilename({
    inputRow: 12,
    checkNumber: "123/456",
    patientName: "Jane Doe",
    patientId: "789:01",
    visitClaimNumber: "810?1535",
  });

  assert.equal(filename, "Jane_Doe_row_12_check_123_456_not_posted.png");
});

test("decides denied status only from clear denial language", () => {
  assert.equal(decidePaymentPostingStatus("paid", []), "Bill Next");
  assert.equal(decidePaymentPostingStatus("denied", []), "Denied");
  assert.equal(decidePaymentPostingStatus("", ["RA denial code"]), "Denied");
});

test("runtime safety guard rejects prohibited semantic actions", () => {
  assert.doesNotThrow(() => assertPaymentPostingActionAllowed("fill-payment"));
  assert.throws(() => assertPaymentPostingActionAllowed("save-and-post"), /blocked prohibited action/);
});

test("output workbook includes schema and dry-run no-post values", async () => {
  const result = createBaseResultRow({
    input: inputRow(),
    portal: "AdvancedMD",
    jobId: "job-1",
    result: "Automation Failed",
    botMessage: "AdvancedMD Portal Implementation Pending. No payment was posted.",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  });
  const buffer = await createPaymentPostingOutputWorkbookBuffer([result]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet("Payment Posting Results");
  assert.ok(worksheet);

  const headers = worksheet!.getRow(1).values as unknown[];
  for (const column of PAYMENT_POSTING_OUTPUT_COLUMNS) {
    assert.ok(headers.includes(column), `missing ${column}`);
  }
  const dryRunColumn = headers.indexOf("Dry Run");
  const postedColumn = headers.indexOf("Posted");
  assert.equal(worksheet!.getRow(2).getCell(dryRunColumn).value, "Yes");
  assert.equal(worksheet!.getRow(2).getCell(postedColumn).value, "No");
});
