import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { CLAIM_STATUS_OUTPUT_HEADERS, appendClaimStatusOutputColumns, claimStatusOutputValues } from "../../workflows/claim-status/output-columns";
import { normalizeIehpServiceWorkbook } from "./iehp-results";
import { normalizeAvailityServiceWorkbook } from "./availity-results";
import { normalizeGenericClaimStatusWorkbook } from "./generic-claim-status-results";
import { claimStatusServicePortalConfigs, type GenericClaimStatusServicePortalId } from "./generic-claim-status-input";
import { recordServiceResultPage } from "./result-publication-store";
import { publicationDatabase } from "./result-publication-test-helpers";
import { createClaimResultPublisher } from "../worker/claim-result-publisher";
import { workerManifestSummary } from "./worker-result-contract";

type Data = Record<string, string | number | null>;
async function workbook(rows: Data[], sheetName = "Claims") {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(sheetName);
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map(header => row[header] ?? null));
  return new Uint8Array(await book.xlsx.writeBuffer());
}
const claim = (extra: Data = {}): Data => ({
  "Client Row Ref": "A", BotClaimStatusCheck: "Success", BotClaimStatusCheckError: "", BotClaimDetails: "Portal checked",
  "RA Check Amount": 9000, "RA Net Paid": 25, "RA Copay": 0, "RA Coins": 2, "RA Deduct Amount": 3,
  "RA Status": "Paid", "RA Reason": "CO-45, N362", "Final Status": "Paid", ...extra,
});

test("IEHP single-row payment includes details and all five canonical columns without using the check total", async () => {
  const summary = await normalizeIehpServiceWorkbook(await workbook([claim()]), ["A"]);
  const row = summary.row_results[0];
  assert.equal(row.status, "SUCCESS");
  assert.equal(row.result.claim_status, "Success");
  assert.equal(row.result.detail_rows?.length, 1);
  const expected = ["CO-45", "N362", "25", "Copay: 0; Coinsurance: 2; Deductible: 3", "Paid"];
  assert.deepEqual(CLAIM_STATUS_OUTPUT_HEADERS.map(header => row.result[header]), expected);
  assert.deepEqual(CLAIM_STATUS_OUTPUT_HEADERS.map(header => row.result.detail_rows?.[0][header]), expected);
  assert.equal(row.result.detail_rows?.[0]["RA Check Amount"], "9000");
});

test("IEHP denied zero-payment claims are successfully processed and prose is never a denial/remark code", async () => {
  const rows = [claim({ "RA Net Paid": 0, "RA Status": "Denied", "Final Status": "Denied", "RA Reason": "Claim denied due to coverage; N362", "RA Denial Reason": "Coverage unavailable" })];
  const summary = await normalizeIehpServiceWorkbook(await workbook(rows), ["A"]);
  const row = summary.row_results[0];
  assert.equal(row.status, "SUCCESS");
  assert.equal(row.error_category, null);
  assert.equal(row.result["Claim Status - Paid Amount"], "0");
  assert.equal(row.result["Claim Status - Final Status"], "Denied");
  assert.equal(row.result["Claim Status - Denial Code"], null);
  assert.equal(row.result["Claim Status - Remark Code"], "N362");
});

test("IEHP preserves explicit canonical workbook fields and RA Net Paid wins over all other amount aliases", async () => {
  const row = claim({ NetPay: 999, "Claim Status - Paid Amount": 9000,
    "Claim Status - Denial Code": "PR-1", "Claim Status - Remark Code": "M15", "Claim Status - Copay/Coins/Ded": "Copay: 0", "Claim Status - Final Status": "Adjudicated Paid" });
  const result = (await normalizeIehpServiceWorkbook(await workbook([row]), ["A"])).row_results[0].result;
  assert.deepEqual(CLAIM_STATUS_OUTPUT_HEADERS.map(header => result[header]), ["PR-1", "M15", "25", "Copay: 0", "Adjudicated Paid"]);
  const missingPaid = claimStatusOutputValues("iehp", { "RA Check Amount": 9000, NetPay: 999, "RA Status": "Paid" });
  assert.equal(missingPaid["Claim Status - Paid Amount"], null);
  assert.equal(missingPaid["Claim Status - Final Status"], "Paid");
});

test("IEHP multiple detail rows stay in one result and never invent an aggregate payment", async () => {
  const summary = await normalizeIehpServiceWorkbook(await workbook([
    claim(), claim({ "RA Net Paid": 0, "Final Status": "Denied", "RA Reason": "PR-1", "RA Status": "Denied" }),
  ]), ["A"]);
  assert.equal(summary.finalized_count, 1);
  const row = summary.row_results[0];
  assert.equal(row.status, "SUCCESS");
  assert.equal(row.result.detail_rows?.length, 2);
  assert.deepEqual(row.result.detail_rows?.map(detail => detail["Claim Status - Paid Amount"]), ["25", "0"]);
  assert.deepEqual(row.result.detail_rows?.map(detail => detail["Claim Status - Final Status"]), ["Paid", "Denied"]);
  assert.equal(row.result["Claim Status - Paid Amount"], null);
  assert.equal(row.result["Claim Status - Final Status"], null);
});

test("IEHP incomplete details wait while later claims publish, then arrive once with their structured values", async () => {
  const rows = [claim(), claim({ BotClaimStatusCheck: "", "RA Net Paid": null, "Final Status": "" }), claim({ "Client Row Ref": "B", "RA Net Paid": 0 })];
  const db = publicationDatabase();
  const base = { jobId: "job", expectedRefs: ["A", "B"], cursor: 0, limit: 100 };
  const partial = await normalizeIehpServiceWorkbook(await workbook(rows), base.expectedRefs);
  assert.equal(partial.row_results[0].status, "INCOMPLETE");
  assert.equal(partial.row_results[0].result.detail_rows?.length, 2);
  const first = await recordServiceResultPage({ ...base, summary: partial }, db.pool);
  assert.deepEqual(first.results.map(row => row.client_row_ref), ["B"]);
  assert.deepEqual(await recordServiceResultPage({ ...base, summary: partial }, db.pool), first);
  rows[1] = claim({ "RA Net Paid": 10 });
  const complete = await normalizeIehpServiceWorkbook(await workbook(rows), base.expectedRefs);
  const late = await recordServiceResultPage({ ...base, cursor: first.nextCursor, summary: complete }, db.pool);
  assert.deepEqual(late.results.map(row => row.client_row_ref), ["A"]);
  assert.equal(late.results[0].result.detail_rows?.length, 2);
  assert.deepEqual((await recordServiceResultPage({ ...base, cursor: late.nextCursor, summary: complete }, db.pool)).results, []);
});

for (const portal of ["iehp", "availity", ...Object.keys(claimStatusServicePortalConfigs)] as const) {
  test(`${portal}: canonical fields and single detail row survive service normalization`, async () => {
    const columns: Data = { "Client Row Ref": "A", BotClaimStatusCheck: "Success", BotClaimStatusCheckError: "", bot_overall_result: "success", bot_updated_claim_status: "Paid", "Bot Status": "Success" };
    CLAIM_STATUS_OUTPUT_HEADERS.forEach((header, index) => { columns[header] = ["45", "N362", 0, "Copay: 0", "Denied"][index]; });
    const bytes = await workbook([columns], portal === "iehp" ? "Claims" : "Output");
    const summary = portal === "iehp" ? await normalizeIehpServiceWorkbook(bytes, ["A"])
      : portal === "availity" ? await normalizeAvailityServiceWorkbook(bytes, ["A"])
        : await normalizeGenericClaimStatusWorkbook(bytes, ["A"], portal as GenericClaimStatusServicePortalId);
    const row = summary.row_results[0];
    assert.equal(row.status, "SUCCESS");
    assert.equal(row.client_row_ref, "A");
    assert.equal(row.result.detail_rows?.length, 1);
    assert.deepEqual(CLAIM_STATUS_OUTPUT_HEADERS.map(header => row.result[header]), ["45", "N362", "0", "Copay: 0", "Denied"]);
  });
}

test("absent fields remain null and processing SUCCESS is never adjudication", async () => {
  const summary = await normalizeIehpServiceWorkbook(await workbook([{
    "Client Row Ref": "A", BotClaimStatusCheck: "Success", BotClaimStatusCheckError: "",
  }]), ["A"]);
  assert.deepEqual(CLAIM_STATUS_OUTPUT_HEADERS.map(header => summary.row_results[0].result[header]), [null, null, null, null, null]);
  assert.equal(claimStatusOutputValues("all-care", { result: "SUCCESS", BotStatus: "SUCCESS" })["Claim Status - Final Status"], null);
});

test("workbook canonical columns refresh on successive snapshots", () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Claims");
  sheet.addRow(["RA Net Paid", "RA Status"]);
  sheet.addRow([25, "Paid"]);
  appendClaimStatusOutputColumns(sheet, "iehp");
  sheet.getRow(2).getCell(1).value = 0;
  sheet.getRow(2).getCell(2).value = "Denied";
  appendClaimStatusOutputColumns(sheet, "iehp");
  const headers = sheet.getRow(1).values as string[];
  assert.equal(sheet.getRow(2).getCell(headers.indexOf("Claim Status - Paid Amount")).value, 0);
  assert.equal(sheet.getRow(2).getCell(headers.indexOf("Claim Status - Final Status")).value, "Denied");
});

test("already recorded results remain immutable; a new parser does not silently repair finalized deliveries", async () => {
  const db = publicationDatabase();
  const input = { jobId: "job", expectedRefs: ["A"], cursor: 0, limit: 100 };
  const corrected = await normalizeIehpServiceWorkbook(await workbook([claim()]), ["A"]);
  const legacy = structuredClone(corrected);
  legacy.row_results[0].result = { claim_status: "Success", claim_details: "Portal checked" };
  const originalPage = await recordServiceResultPage({ ...input, summary: legacy }, db.pool);
  const page = await recordServiceResultPage({ ...input, summary: corrected }, db.pool);
  assert.deepEqual(page.results, originalPage.results);
  assert.equal(page.results[0].result.detail_rows, undefined);
});

test("worker-finalized cancelled claims without any workbook expose all five columns without inventing data", async () => {
  const db = publicationDatabase();
  const worker = createClaimResultPublisher({ jobId: "job", expectedRefs: ["A"], save: async () => {} });
  const manifest = await worker.finish("CANCELLED");
  const page = await recordServiceResultPage({ jobId: "job", expectedRefs: ["A"], cursor: 0, limit: 100,
    summary: workerManifestSummary(manifest, ["A"]), terminalStatus: "cancelled", claimStatusPortal: "iehp" }, db.pool);
  assert.equal(page.results[0].status, "FAILED");
  assert.equal(page.results[0].error_category, "CANCELLED");
  assert.deepEqual(page.results[0].result.detail_rows, []);
  assert.deepEqual(CLAIM_STATUS_OUTPUT_HEADERS.map(header => page.results[0].result[header]), [null, null, null, null, null]);
});

test("IEHP cached formula zero is preserved as payment", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Claims");
  sheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "RA Net Paid"]);
  sheet.addRow(["A", "Success", "", { formula: "1-1", result: 0 }]);
  const summary = await normalizeIehpServiceWorkbook(new Uint8Array(await book.xlsx.writeBuffer()), ["A"]);
  assert.equal(summary.row_results[0].result["Claim Status - Paid Amount"], "0");
});
