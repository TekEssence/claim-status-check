import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import * as XLSX from "xlsx";
import { buildAerialFinalStatus } from "../claim-status-job";
import { createAerialOutputWorkbookBuffer, readAerialInputWorkbookFromBuffer } from "../workbook";

const require = createRequire(import.meta.url);
const { extractClaimStatusFromText, extractLabelValueFromText } = require("../legacy/claim-detail-page.js") as {
  extractClaimStatusFromText: (text: string) => string;
  extractLabelValueFromText: (text: string, label: string) => string;
};

test("Aerial carries input Claim No column A into output workbook", () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    inputWorkbook,
    XLSX.utils.aoa_to_sheet([
      ["Claim No", "", "", "", "", "", "", "Subscriber No", "", "", "Service Date"],
      ["CLM-1001", "", "", "", "", "", "", "123456789", "", "", "10/09/2025"],
    ]),
    "Input",
  );

  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const inputArrayBuffer = inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.byteLength) as ArrayBuffer;
  const [row] = readAerialInputWorkbookFromBuffer(inputArrayBuffer);
  assert.equal(row["Claim No"], "CLM-1001");

  const outputBuffer = createAerialOutputWorkbookBuffer(
    [
      {
        inputRowId: row.input_row_id,
        inputClaimNo: row["Claim No"],
        subscriberNo: row.normalized.subscriberNo,
        serviceDate: row.normalized.serviceDate,
        result: "success",
        extractedAt: "2026-06-22T00:00:00.000Z",
      },
    ],
    { errorRows: [], auditRows: [] },
  );
  const outputWorkbook = XLSX.read(outputBuffer, { type: "buffer" });
  const outputRows = XLSX.utils.sheet_to_json(outputWorkbook.Sheets.Output) as Record<string, unknown>[];

  assert.equal(outputRows[0].input_claim_no, "CLM-1001");
});

test("Aerial finds Subscriber No and Service Date by column header names", () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    inputWorkbook,
    XLSX.utils.aoa_to_sheet([
      ["Other", "Service Date", "Claim No", "Subscriber No"],
      ["ignored", "10/09/2025", "CLM-2002", "987654321"],
    ]),
    "Input",
  );

  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const inputArrayBuffer = inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.byteLength) as ArrayBuffer;
  const [row] = readAerialInputWorkbookFromBuffer(inputArrayBuffer);

  assert.equal(row["Claim No"], "CLM-2002");
  assert.equal(row["Subscriber No"], "987654321");
  assert.equal(row["Service Date"], "10/09/2025");
});

test("Aerial removes XEE prefix from Subscriber No before processing", () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    inputWorkbook,
    XLSX.utils.aoa_to_sheet([
      ["Claim No", "Subscriber No", "Service Date"],
      ["CLM-3003", "XEE123456789", "10/09/2025"],
    ]),
    "Input",
  );

  const inputBuffer = XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const inputArrayBuffer = inputBuffer.buffer.slice(inputBuffer.byteOffset, inputBuffer.byteOffset + inputBuffer.byteLength) as ArrayBuffer;
  const [row] = readAerialInputWorkbookFromBuffer(inputArrayBuffer);

  assert.equal(row["Subscriber No"], "XEE123456789");
  assert.equal(row.normalized.subscriberNo, "123456789");
});

test("Aerial output workbook includes total_paid and final_status columns", () => {
  const outputBuffer = createAerialOutputWorkbookBuffer(
    [
      {
        inputRowId: 2,
        inputClaimNo: "CLM-4004",
        subscriberNo: "123456789",
        serviceDate: "10/09/2025",
        claimNumber: "AERIAL-CLAIM-1",
        totalPaid: "$91.07",
        finalStatus: "DOS 10/09/2025: Checked IEHP portal claim received on 10/10/2025 paid on 10/12/2025 paid amount $91.07 EFT/Check # EFT123. Claim # AERIAL-CLAIM-1.",
        serviceLines: [{ serviceCode: "J0702", paid: "$22.27" }],
        result: "success",
        extractedAt: "2026-06-22T00:00:00.000Z",
      },
    ],
    { errorRows: [], auditRows: [] },
  );
  const outputWorkbook = XLSX.read(outputBuffer, { type: "buffer" });
  const outputRows = XLSX.utils.sheet_to_json(outputWorkbook.Sheets.Output) as Record<string, unknown>[];

  assert.equal(outputRows[0].total_paid, "$91.07");
  assert.equal(
    outputRows[0].final_status,
    "DOS 10/09/2025: Checked IEHP portal claim received on 10/10/2025 paid on 10/12/2025 paid amount $91.07 EFT/Check # EFT123. Claim # AERIAL-CLAIM-1.",
  );
});

test("Aerial final_status uses paid wording only when claim status is APPROVED", () => {
  const inputRow = {
    input_row_id: 2,
    "Claim No": "CLM-5005",
    "Subscriber No": "123456789",
    "Service Date": "10/09/2025",
    validation_status: "valid" as const,
    validation_message: "",
    normalized: { subscriberNo: "123456789", serviceDate: "10/09/2025" },
    validation_errors: [],
  };

  assert.equal(
    buildAerialFinalStatus(
      inputRow,
      {
        claimStatus: "APPROVED",
        dateReceived: "10/10/2025",
        datePaid: "10/12/2025",
        checkNumber: "EFT123",
        claimNumber: "AERIAL-CLAIM-2",
        eobFound: true,
      },
      "$91.07",
    ),
    "DOS 10/09/2025: Checked IEHP portal claim received on 10/10/2025 paid on 10/12/2025 paid amount $91.07 EFT/Check # EFT123. Claim # AERIAL-CLAIM-2.",
  );

  assert.equal(
    buildAerialFinalStatus(
      inputRow,
      {
        claimStatus: "DENIED",
        dateReceived: "10/10/2025",
        rejectDate: "10/13/2025",
        denialReason: "Not covered",
        claimNumber: "AERIAL-CLAIM-3",
        eobFound: true,
      },
      "$0.00",
    ),
    "DOS 10/09/2025: Checked IEHP portal claim received on 10/10/2025 denied on 10/13/2025 denial reason Not covered. Claim# AERIAL-CLAIM-3.",
  );
});

test("Aerial claim status extraction stops before adjacent Date Received label", () => {
  const popupText = "Status: APPROVED Date Received: 5/29/2026";

  assert.equal(extractClaimStatusFromText(popupText), "APPROVED");
  assert.equal(extractLabelValueFromText(popupText, "Date Received"), "5/29/2026");
});
