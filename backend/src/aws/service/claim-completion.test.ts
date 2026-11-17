import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { classifyClaimCompletion, claimWorkerStatusFields } from "./claim-completion";
import { claimStatusServicePortalConfigs, type GenericClaimStatusServicePortalId } from "./generic-claim-status-input";
import { normalizeGenericClaimStatusWorkbook } from "./generic-claim-status-results";
import { normalizeAvailityServiceWorkbook } from "./availity-results";
import { normalizeIehpServiceWorkbook } from "./iehp-results";
import { completeResultsForWorkbook, createOptumProOutputWorkbookBuffer } from "../../scrapers/optum-pro/claim-status";
import { recordServiceResultPage } from "./result-publication-store";
import { publicationDatabase } from "./result-publication-test-helpers";
import { summarizeServiceResults } from "./result-summary";
import { ServicePublicationError } from "./result-publication";
import type { OptumProInputRow } from "../../scrapers/optum-pro/input";
import type { ServiceRowResult } from "./service-contract";
import { createClaimResultPublisher } from "../worker/claim-result-publisher";
import { workerManifestSummary } from "./worker-result-contract";

type Portal = "availity" | "iehp" | GenericClaimStatusServicePortalId;
const portals: Portal[] = ["availity", "iehp", ...Object.keys(claimStatusServicePortalConfigs) as GenericClaimStatusServicePortalId[]];

async function normalize(portal: Portal, records: Record<string, string>[], refs: string[]) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(portal === "iehp" ? "Claims" : "Output");
  const headers = [...new Set(records.flatMap(row => Object.keys(row)))];
  sheet.addRow(headers);
  for (const row of records) sheet.addRow(headers.map(header => row[header] ?? ""));
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  return portal === "availity" ? normalizeAvailityServiceWorkbook(bytes, refs)
    : portal === "iehp" ? normalizeIehpServiceWorkbook(bytes, refs)
      : normalizeGenericClaimStatusWorkbook(bytes, refs, portal);
}

for (const portal of portals) {
  test(`${portal}: prefilled and unknown worker states never publish despite populated input/canonical fields`, async () => {
    const marker = claimWorkerStatusFields(portal)[0];
    const pending = ["Not processed", "Not processed.", "Not processed - job stopped", "Not started", "Not checked", "Pending", "Queued", "Running", "In Progress", "-", "", "a new unrecognized worker state"];
    const records = pending.map((value, index) => ({
      "Client Row Ref": `P${index}`, [marker]: value,
      "BotClaimStatusCheckError": "", "bot_updated_claim_status": "Paid",
      "Status": "Paid", "Claim Status": "Paid", "Claim Status - Final Status": "Paid", "Final Status": "Paid",
      "notes": "Prior error; OTP required on a previous attempt", "Bot Message": "No claims found on a previous attempt",
    }));
    records.push({ ...records[0], "Client Row Ref": "DONE", [marker]: "Success", "Bot Message": "Done" });
    const refs = records.map(row => row["Client Row Ref"]);
    const summary = await normalize(portal, records, refs);
    assert.equal(summary.finalized_count, 1);
    assert.equal(summary.counts.incomplete, pending.length);
    assert.equal(summary.row_results.at(-1)?.status, "SUCCESS");
    const db = publicationDatabase();
    const input = { jobId: "job", expectedRefs: refs, summary, cursor: 0, limit: 200, claimStatusPortal: portal };
    const page = await recordServiceResultPage(input, db.pool);
    assert.equal(page.processed, 1);
    assert.equal(page.pending, pending.length);
    assert.equal(page.nextCursor, 1);
    assert.deepEqual(page.results.map(row => row.client_row_ref), ["DONE"]);
    assert.deepEqual(await recordServiceResultPage(input, db.pool), page);
    assert.deepEqual((await recordServiceResultPage({ ...input, cursor: 1 }, db.pool)).results, []);
  });
}

test("real Optum writer: 17 of 359 completed lookups publish 17, then append a late earlier claim once", async () => {
  const rows: OptumProInputRow[] = Array.from({ length: 359 }, (_, index) => ({
    rowNumber: index + 2, raw: { "Client Row Ref": `R${index}`, Status: "Paid" },
    medicalGroupName: "Fixture Group", patient: "Fixture Patient", dos: "01/01/2026", cpt: "99213", memberId: "SAME-LOOKUP",
  }));
  const refs = rows.map(row => String(row.raw["Client Row Ref"]));
  const complete = completeResultsForWorkbook(rows, rows.map(() => null), false);
  const db = publicationDatabase();
  const empty = await normalizeGenericClaimStatusWorkbook(await createOptumProOutputWorkbookBuffer(complete), refs, "optum-pro");
  const emptyPage = await recordServiceResultPage({ jobId: "job", expectedRefs: refs, summary: empty,
    cursor: 0, limit: 200, claimStatusPortal: "optum-pro" }, db.pool);
  assert.equal(emptyPage.processed, 0);
  assert.equal(emptyPage.pending, 359);
  assert.equal(emptyPage.nextCursor, 0);
  assert.deepEqual(emptyPage.results, []);
  const finished = Array.from({ length: 17 }, (_, index) => index * 20 + 1);
  for (const index of finished) Object.assign(complete[index], {
    status: "Completed", notes: "Claim found.", claimStatus: "Denied", lineStatus: "Denied", claimNumber: `fixture-${index}`, paidAmount: "0",
  });
  complete[finished[0]].status = "No claims found";
  const parse = async () => normalizeGenericClaimStatusWorkbook(await createOptumProOutputWorkbookBuffer(complete), refs, "optum-pro");
  const summary = await parse();
  assert.equal(summary.finalized_count, 17);
  assert.equal(summary.counts.success, 16);
  assert.equal(summary.counts.no_match, 1);
  assert.equal(summary.counts.incomplete, 342);
  const input = { jobId: "job", expectedRefs: refs, summary, cursor: 0, limit: 200, claimStatusPortal: "optum-pro" };
  const first = await recordServiceResultPage(input, db.pool);
  assert.equal(first.results.length, 17);
  assert.equal(first.processed, 17);
  assert.equal(first.pending, 342);
  assert.equal(first.nextCursor, 17);
  assert.deepEqual(await recordServiceResultPage(input, db.pool), first);
  const paid = first.results.find(row => row.status === "SUCCESS");
  assert.equal(paid?.result["Claim Status - Paid Amount"], "0");
  assert.equal(paid?.result["Claim Status - Final Status"], "Denied");
  Object.assign(complete[0], { status: "Completed", notes: "Claim found.", lineStatus: "Paid", paidAmount: "25" });
  const late = await recordServiceResultPage({ ...input, summary: await parse(), cursor: first.nextCursor }, db.pool);
  assert.deepEqual(late.results.map(row => row.client_row_ref), ["R0"]);
  assert.equal(late.nextCursor, 18);
  assert.equal(new Set(db.stored().map(row => row.client_row_ref)).size, 18);
});

test("blank worker columns and absent worker markers never fall back to submitted Status, notes or canonical fields", async () => {
  const cases: Record<string, string>[] = [
    { "Bot Status": "", Status: "Paid", "Claim Status": "Denied", "Claim Status - Final Status": "Paid" },
    { Status: "Success", notes: "Done", "Claim Status": "Paid", "Claim Status - Final Status": "Paid" },
  ];
  for (const row of cases) {
    const summary = await normalize("optum-pro", [{ "Client Row Ref": "A", ...row }], ["A"]);
    assert.equal(summary.row_results[0].status, "INCOMPLETE");
    assert.equal(summary.finalized_count, 0);
  }
});

test("a grouped claim with unfinished details remains pending even when another detail failed", async () => {
  const summary = await normalize("optum-pro", [
    { "Client Row Ref": "A", "Bot Status": "Error", "Bot Message": "Portal failed" },
    { "Client Row Ref": "A", "Bot Status": "Not processed", "Bot Message": "Not processed." },
    { "Client Row Ref": "B", "Bot Status": "Success", "Bot Message": "Done" },
  ], ["A", "B"]);
  assert.equal(summary.row_results[0].status, "INCOMPLETE");
  assert.equal(summary.row_results[1].status, "SUCCESS");
  assert.equal(summary.finalized_count, 1);
});

test("native adjudication statuses remain completed lookups without confusing worker placeholders", () => {
  const cases: Array<[Portal, Record<string, unknown>, string]> = [
    ["blue-shield", { "Bot Status": "Paid" }, "SUCCESS"],
    ["blue-shield", { "Bot Status": "Denied" }, "SUCCESS"],
    ["blue-shield", { "Bot Status": "Claim pending" }, "SUCCESS"],
    ["optum-pro", { "Bot Status": "In Progress", "Search Result Claim Number": "fixture-claim" }, "SUCCESS"],
    ["optum-pro", { "Bot Status": "In Process", "Search Result Claim Number": "fixture-claim" }, "SUCCESS"],
    ["optum-pro", { "Bot Status": "Claim In Progress", "Search Result Claim Number": "fixture-claim" }, "SUCCESS"],
    ["optum-pro", { "Bot Status": "In Progress", "Search Result Claim Number": "-" }, "INCOMPLETE"],
    ["optum-pro", { "Bot Status": "Not processed", "Search Result Claim Number": "fixture-claim" }, "INCOMPLETE"],
    ["waystar", { status: "paid" }, "SUCCESS"],
    ["waystar", { status: "denial" }, "SUCCESS"],
    ["waystar", { status: "NA", Remarks: "eob was not in the waystar portal" }, "NO_MATCH"],
    ["waystar", { status: "NA" }, "INCOMPLETE"],
    ["medpoint", { final_status: "Pending", search_result_index: "1" }, "SUCCESS"],
    ["medpoint", { final_status: "Not processed", search_result_index: "1" }, "INCOMPLETE"],
    ["medpoint", { final_status: "Paid" }, "INCOMPLETE"],
    ["medpoint", { final_status: "Portal Error", search_result_index: "1" }, "FAILED"],
    ["regal", { final_status: "DOS: Checked claim. Paid.", search_result_index: "1" }, "SUCCESS"],
    ["regal", { final_status: "No claims on file." }, "NO_MATCH"],
    ["cigna", { "Bot Status": "No Member ID" }, "FAILED"],
    ["optum-pro", { "Bot Status": "Success", result: "Not processed", bot_overall_result: "Not processed" }, "SUCCESS"],
    ["aerial", { result: "Not processed", "Bot Status": "Success" }, "INCOMPLETE"],
    ["uhc", { BotStatus: "", "Bot Status": "Success", Status: "Paid" }, "INCOMPLETE"],
    ["kaiser", { "Bot Status": "Review required" }, "ACTION_REQUIRED"],
    ["uhc", { BotStatus: "Skipped", BotStatusError: "No claim found for subscriber" }, "NO_MATCH"],
    ["iehp", { BotClaimStatusCheck: "Not processed", BotClaimStatusCheckError: "No claim found" }, "INCOMPLETE"],
    ["availity", { bot_overall_result: "Success", bot_notes: "Denied claim" }, "SUCCESS"],
  ];
  for (const [portal, row, expected] of cases) assert.equal(classifyClaimCompletion(portal, row).status, expected, `${portal}: ${JSON.stringify(row)}`);
});

test("already-frozen false successes stop every page and progress response without rewriting rows or skipping cursors", async () => {
  const legacy: ServiceRowResult = {
    client_row_ref: "A", status: "SUCCESS", error_category: null, error_message: null,
    result: { detail_rows: [{ "Bot Status": "Not processed", "Bot Message": "Not processed." }] },
  };
  const db = publicationDatabase();
  const input = { jobId: "job", expectedRefs: ["A"], summary: summarizeServiceResults([legacy]), cursor: 0, limit: 100 };
  await recordServiceResultPage(input, db.pool); // Simulate the old parser's stored payload.
  const frozen = db.stored();
  for (const cursor of [0, 1]) {
    await assert.rejects(recordServiceResultPage({ ...input, claimStatusPortal: "optum-pro", cursor }, db.pool),
      error => error instanceof ServicePublicationError && error.statusCode === 503 && /audited correction/.test(error.message));
  }
  assert.deepEqual(db.stored(), frozen);
  assert.ok(db.queries.includes("ROLLBACK"));
});

test("publication validation independently rejects new false successes even if a parser regresses", async () => {
  const db = publicationDatabase();
  const row: ServiceRowResult = { client_row_ref: "A", status: "SUCCESS", error_category: null, error_message: null,
    result: { detail_rows: [{ "Bot Status": "Not processed" }] } };
  await assert.rejects(recordServiceResultPage({ jobId: "job", expectedRefs: ["A"], summary: summarizeServiceResults([row]),
    cursor: 0, limit: 100, claimStatusPortal: "optum-pro" }, db.pool), ServicePublicationError);
  assert.deepEqual(db.stored(), []);
});

test("frozen successes with blank, unknown or unsuccessful worker states are not delivered as successes", async () => {
  for (const marker of ["", "new unknown state", "No claims found", "Portal Error"]) {
    const db = publicationDatabase();
    const row: ServiceRowResult = { client_row_ref: "A", status: "SUCCESS", error_category: null, error_message: null,
      result: { detail_rows: [{ "Bot Status": marker, Status: "Paid", "Claim Status - Final Status": "Paid" }] } };
    const input = { jobId: "job", expectedRefs: ["A"], summary: summarizeServiceResults([row]), cursor: 0, limit: 100 };
    await recordServiceResultPage(input, db.pool);
    await assert.rejects(recordServiceResultPage({ ...input, claimStatusPortal: "optum-pro" }, db.pool), ServicePublicationError);
    assert.deepEqual(db.stored()[0].result, row);
  }
});

test("only the worker finalizes terminal placeholders; Lambda never fills them", async () => {
  const summary = await normalize("optum-pro", [{ "Client Row Ref": "A", "Bot Status": "Not processed", "Final Status": "-" }], ["A"]);
  const db = publicationDatabase();
  const input = { jobId: "job", expectedRefs: ["A"], summary, cursor: 0, limit: 100, claimStatusPortal: "optum-pro" };
  assert.equal((await recordServiceResultPage(input, db.pool)).processed, 0);
  assert.equal((await recordServiceResultPage({ ...input, terminalStatus: "failed" }, db.pool)).processed, 0);
  const worker = createClaimResultPublisher({ jobId: "job", expectedRefs: ["A"], save: async () => {} });
  const manifest = await worker.finish("OUTPUT_MISSING");
  const finalInput = { ...input, terminalStatus: "failed", summary: workerManifestSummary(manifest, ["A"]) };
  const terminal = await recordServiceResultPage(finalInput, db.pool);
  assert.equal(terminal.results[0].status, "FAILED");
  assert.equal(terminal.results[0].error_category, "OUTPUT_MISSING");
  assert.equal(terminal.results[0].result["Claim Status - Final Status"], null);
  assert.deepEqual(await recordServiceResultPage(finalInput, db.pool), terminal);
});
