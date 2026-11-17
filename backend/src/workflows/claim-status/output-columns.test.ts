import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { appendClaimStatusOutputColumns, CLAIM_STATUS_OUTPUT_HEADERS, claimStatusOutputValues } from "./output-columns";
import { createAllCareWorkbook } from "./portals/all-care/workbook";

test("projects separate claim fields and preserves zero amounts", () => {
  const result = claimStatusOutputValues("all-care", {
    CARC: "CO-45", RARC: "N362", NetPay: "0.00", Copay: "0.00", Coins: "3.20", Deductible: "5.00", final_status: "Denied",
  });
  assert.deepEqual(Object.values(result), ["CO-45", "N362", "0.00", "Copay: 0.00; Coinsurance: 3.20; Deductible: 5.00", "Denied"]);
});

test("projects labeled service-line values without inventing unavailable fields", () => {
  const result = claimStatusOutputValues("my-family", {
    "Service Lines": "Service Code: 99213 | Deductible: 10.00 | Copay: 2.00 | Coinsurance: 3.00 | Net Paid: 25.00 | Adj Code: CO-45 | Remitt_Code: N362",
    "Final Status": "Paid",
  });
  assert.deepEqual(Object.values(result), ["CO-45", "N362", "25.00", "Copay: 2.00; Coinsurance: 3.00; Deductible: 10.00", "Paid"]);
  const missing = claimStatusOutputValues("aerial", { final_status: "No claims found" });
  assert.deepEqual(Object.values(missing), [null, null, null, null, "No claims found"]);
});

test("uses clearly labeled amounts in portal detail text and leaves untyped codes blank", () => {
  const uhc = claimStatusOutputValues("uhc", {
    BotDenialReasonCode: "CO-45", BotRemarkCodes: "N362", BotPaidAmount: "$0.00",
    BotClaimDetails: "Copay: $2.00\nCoinsurance: $3.00\nDeductible: $4.00", BotClaimResult: "Denied",
  });
  assert.deepEqual(Object.values(uhc), ["CO-45", "N362", "$0.00", "Copay: $2.00; Coinsurance: $3.00; Deductible: $4.00", "Denied"]);
  const availity = claimStatusOutputValues("availity", {
    bot_updated_claim_status: "DOS 04/22/2026: paid amount $25.00 with copay of $2.00, coinsurance of $3.00, and deductible of $4.00.",
  });
  assert.equal(availity["Claim Status - Paid Amount"], "$25.00");
  assert.equal(availity["Claim Status - Remark Code"], null);
  assert.equal(availity["Claim Status - Copay/Coins/Ded"], "Copay: $2.00; Coinsurance: $3.00; Deductible: $4.00");
  const denied = claimStatusOutputValues("availity", { bot_updated_claim_status: "Claim denied on 04/22/2026 denial reason 97 - Included in payment." });
  assert.equal(denied["Claim Status - Denial Code"], null);
  assert.equal(denied["Claim Status - Remark Code"], null);
});

test("splits identifiable IEHP remark codes from the RA reason field", () => {
  const result = claimStatusOutputValues("iehp", {
    "RA Reason": "59, 001167, 119, N362",
    "RA Net Paid": "0.00",
    "RA Copay": "0.00",
    "RA Coins": "0.00",
    "RA Deduct Amount": "0.00",
    "Final Status": "Denied",
  });
  assert.deepEqual(Object.values(result), ["59, 001167, 119", "N362", "0.00", "Copay: 0.00; Coinsurance: 0.00; Deductible: 0.00", "Denied"]);
});

test("appends the same five columns to an Excel output sheet without changing source cells", () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Output");
  sheet.addRow(["CARC", "RARC", "NetPay", "Final Status"]);
  sheet.addRow(["45", "N362", 0, "Denied"]);
  appendClaimStatusOutputColumns(sheet, "all-care");
  const headers = sheet.getRow(1).values as string[];
  assert.deepEqual(headers.slice(-5), [...CLAIM_STATUS_OUTPUT_HEADERS]);
  assert.equal(sheet.getRow(2).getCell(1).value, "45");
  assert.deepEqual(Array.from((sheet.getRow(2).values as unknown[]).slice(-5), (cell) => cell ?? null), ["45", "N362", 0, null, "Denied"]);
});

test("keeps the standardized headers when no claim rows were produced", () => {
  const workbook = XLSX.read(createAllCareWorkbook([], [], []), { type: "buffer" });
  const sheet = workbook.Sheets.Output;
  const headers = (XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][])[0];
  assert.deepEqual(headers, [...CLAIM_STATUS_OUTPUT_HEADERS]);
});
