import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { generateIehpServiceInput, maskIehpAccountLabel, validateIehpServiceInput } from "./iehp-input";
import { normalizeIehpServiceWorkbook, pageIehpServiceResults } from "./iehp-results";
import { postProcessWorksheet } from "../../workflows/claim-status/portals/iehp/workbook-output";

const request = {
  credentials: { login_url: "https://example.test/login", username: "user", password: "example-secret" },
  claims: [
    { client_row_ref: "ar-101", data: { "Member Policy ID": "M101", "Date Of Service": "10/01/2026", "Claim No": "C101" } },
    { client_row_ref: "ar-102", data: { "Member Policy ID": "M102", "Date Of Service": "10/02/2026", "Claim No": "C102" } },
  ],
};

test("IEHP service account label is useful without exposing the full username", () => {
  assert.equal(maskIehpAccountLabel("alice@example.test"), "a***@example.test");
  assert.equal(maskIehpAccountLabel("portaluser"), "p***r");
  assert.equal(maskIehpAccountLabel("alice@example.test").includes("alice"), false);
});

test("service input produces correlated IEHP rows and keeps credentials out of claim data", async () => {
  const generated = await generateIehpServiceInput(validateIehpServiceInput(request));
  const rows = JSON.parse(generated.claimRowsJson) as Array<Record<string, unknown>>;
  assert.deepEqual(rows.map((row) => [row["Client Row Ref"], row.__original_index]), [["ar-101", 0], ["ar-102", 1]]);
  assert.equal(generated.claimRowsJson.includes("example-secret"), false);
  const claimWorkbook = new ExcelJS.Workbook();
  await claimWorkbook.xlsx.load(generated.claimWorkbook as unknown as Parameters<typeof claimWorkbook.xlsx.load>[0]);
  assert.equal(claimWorkbook.worksheets[0].getCell("A2").value, "ar-101");
  const loginWorkbook = new ExcelJS.Workbook();
  await loginWorkbook.xlsx.load(generated.loginWorkbook as unknown as Parameters<typeof loginWorkbook.xlsx.load>[0]);
  assert.equal(loginWorkbook.worksheets[0].getCell("C2").value, "example-secret");
});

test("service output reports successful and failed rows without losing the Excel result", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails"]);
  worksheet.addRow(["ar-101", "Success", "", "Paid"]);
  worksheet.addRow(["ar-102", "Failed", "No matching rows found for DOS", ""]);
  const summary = await normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101", "ar-102"]);
  assert.equal(summary.outcome, "PARTIAL_SUCCESS");
  assert.deepEqual(summary.counts, { total: 2, success: 1, no_match: 1, failed: 0, action_required: 0, incomplete: 0 });
  assert.deepEqual(summary.row_results.map((row) => [row.client_row_ref, row.status]), [["ar-101", "SUCCESS"], ["ar-102", "NO_MATCH"]]);
});

test("output with missing client row references is rejected", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError"]);
  worksheet.addRow(["ar-101", "Success", ""]);
  await assert.rejects(
    normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101", "ar-102"]),
    /1 of 2 expected/,
  );
});

test("rows without a successful claim produce a failed job summary", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError"]);
  worksheet.addRow(["ar-101", "Failed", "No matching rows found for DOS"]);
  worksheet.addRow(["ar-102", "Failed", "Portal was unavailable"]);
  const summary = await normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101", "ar-102"]);
  assert.equal(summary.outcome, "FAILED");
  assert.deepEqual(summary.row_results.map((row) => row.status), ["NO_MATCH", "FAILED"]);
});

test("snapshot normalizer keeps submitted order and only advances through finalized rows", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError"]);
  worksheet.addRow(["ar-103", "Success", ""]);
  worksheet.addRow(["ar-101", "Success", ""]);
  worksheet.addRow(["ar-102", "", ""]);
  const summary = await normalizeIehpServiceWorkbook(
    new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101", "ar-102", "ar-103"],
  );
  assert.deepEqual(summary.row_results.map((row) => row.client_row_ref), ["ar-101", "ar-102", "ar-103"]);
  assert.equal(summary.finalized_count, 1);
  assert.deepEqual(summary.row_results.map((row) => row.status), ["SUCCESS", "INCOMPLETE", "SUCCESS"]);
});

test("early workbook without bot columns yields zero finalized rows", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Client Row Ref", "Member Policy ID"]);
  worksheet.addRow(["ar-101", "M101"]);
  worksheet.addRow(["ar-102", "M102"]);
  const summary = await normalizeIehpServiceWorkbook(
    new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101", "ar-102"], { requireStatusColumns: false },
  );
  assert.equal(summary.finalized_count, 0);
  assert.equal(summary.counts.incomplete, 2);
});

test("one submitted claim with one output row keeps its original result shape", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Claims");
  sheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails"]);
  sheet.addRow(["ar-101", "Success", "", "One paid claim"]);

  const summary = await normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101"]);
  assert.deepEqual(summary.row_results, [{
    client_row_ref: "ar-101", status: "SUCCESS",
    result: { claim_status: "Success", claim_details: "One paid claim" },
    error_category: null, error_message: null,
  }]);
  assert.equal(summary.finalized_count, 1);
});

test("one submitted claim groups the multiple detail rows produced by IEHP workbook formatting", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Claims");
  sheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails"]);
  const claimDetails = "Summary: [DOS: 10/01/2026] Details: [Check #: CHECK-1] Status Info: [Paid] | " +
    "Summary: [DOS: 10/01/2026] Details: [Check #: CHECK-2] Status Info: [Paid]";
  sheet.addRow(["ar-101", "Success", "", claimDetails]);
  postProcessWorksheet(sheet);
  assert.equal(sheet.rowCount, 3);

  const summary = await normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101"]);
  assert.equal(summary.row_results.length, 1);
  assert.equal(summary.row_results[0].status, "SUCCESS");
  assert.equal(summary.row_results[0].result.claim_details, claimDetails);
  assert.deepEqual(summary.row_results[0].result.detail_rows?.map((row) => row["Check Number"]), ["CHECK-1", "CHECK-2"]);
  assert.equal(summary.finalized_count, 1);
  assert.equal(summary.counts.total, 1);
});

test("multiple claims retain submitted order and aggregate differing detail statuses conservatively", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Claims");
  sheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails", "Final Status", "BotReferRA"]);
  sheet.addRow(["ar-102", "Success", "", "Second claim", "Paid", ""]);
  sheet.addRow(["ar-101", "Success", "", "First detail", "Paid", "RA detail one"]);
  sheet.addRow(["ar-101", "Failed", "Portal detail failed", "Second detail", "Denied", "RA detail two"]);

  const summary = await normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101", "ar-102"]);
  assert.deepEqual(summary.row_results.map((row) => [row.client_row_ref, row.status]), [
    ["ar-101", "FAILED"], ["ar-102", "SUCCESS"],
  ]);
  assert.equal(summary.outcome, "PARTIAL_SUCCESS");
  assert.equal(summary.row_results[0].result.claim_details, "First detail\nSecond detail");
  assert.deepEqual(summary.row_results[0].result.detail_rows?.map((row) => row["Final Status"]), ["Paid", "Denied"]);
  assert.deepEqual(summary.row_results[0].result.detail_rows?.map((row) => row.BotReferRA), ["RA detail one", "RA detail two"]);
  assert.equal(summary.row_results[0].error_message, "Portal detail failed");
});

test("repeating a cursor returns the same normalized claim result", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Claims");
  sheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails", "Final Status"]);
  sheet.addRow(["ar-101", "Success", "", "Both detail records", "Paid"]);
  sheet.addRow(["ar-101", "Success", "", "Both detail records", "In Progress"]);
  sheet.addRow(["ar-102", "Success", "", "Second claim", "Paid"]);
  const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());

  const firstPoll = pageIehpServiceResults(await normalizeIehpServiceWorkbook(bytes, ["ar-101", "ar-102"]), 0, 1, true);
  const repeatedPoll = pageIehpServiceResults(await normalizeIehpServiceWorkbook(bytes, ["ar-101", "ar-102"]), 0, 1, true);
  assert.deepEqual(repeatedPoll, firstPoll);
  assert.equal(firstPoll.nextCursor, 1);
  assert.deepEqual(firstPoll.results.map((row) => row.client_row_ref), ["ar-101"]);
});

test("cursor advances once per submitted claim, not per IEHP detail row", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Claims");
  sheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails"]);
  sheet.addRow(["ar-101", "Success", "", "Detail one"]);
  sheet.addRow(["ar-101", "Success", "", "Detail two"]);
  sheet.addRow(["ar-102", "Success", "", "Next claim"]);
  const summary = await normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101", "ar-102"]);

  const firstPage = pageIehpServiceResults(summary, 0, 1, true);
  const secondPage = pageIehpServiceResults(summary, firstPage.nextCursor, 1, true);
  assert.deepEqual(firstPage.results.map((row) => row.client_row_ref), ["ar-101"]);
  assert.equal(firstPage.nextCursor, 1);
  assert.deepEqual(secondPage.results.map((row) => row.client_row_ref), ["ar-102"]);
  assert.equal(secondPage.nextCursor, 2);
  assert.equal(summary.finalized_count, 2);
});

test("a claim with an incomplete detail row does not advance the active cursor", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Claims");
  sheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails"]);
  sheet.addRow(["ar-101", "Success", "", "First detail"]);
  sheet.addRow(["ar-101", "", "", "Second detail"]);
  const partial = await normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101"]);

  assert.equal(partial.row_results[0].status, "INCOMPLETE");
  assert.deepEqual(pageIehpServiceResults(partial, 0, 100, false), { available: 0, nextCursor: 0, results: [] });

  sheet.getRow(3).getCell(2).value = "Success";
  const finished = await normalizeIehpServiceWorkbook(new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-101"]);
  assert.equal(finished.row_results[0].status, "SUCCESS");
  assert.equal(pageIehpServiceResults(finished, 0, 100, false).nextCursor, 1);
});
