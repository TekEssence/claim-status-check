import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { completedWorkerWorkbookResults, createClaimResultPublisher } from "./claim-result-publisher";
import { appendClaimStatusOutputColumns, CLAIM_STATUS_OUTPUT_HEADERS, clearPreviousWorkerOutput } from "../../workflows/claim-status/output-columns";
import { workerExecutionOutcome, WORKER_OUTCOME_COLUMN } from "../../workflows/claim-status/worker-outcome";
import { servicePortals } from "../service/portal-dispatch";
import { loadWorkerResultSnapshot } from "../service/worker-result-snapshot";
import { validateWorkerManifest, workerManifestSummary, type WorkerResultManifest } from "../service/worker-result-contract";
import { planServiceResultPublications } from "../service/result-publication";
import { recordServiceResultPage } from "../service/result-publication-store";
import { publicationDatabase } from "../service/result-publication-test-helpers";
import { applyUhcRowUpdateToWorksheet, postProcessUhcWorksheet } from "../../workflows/claim-status/portals/uhc/workbook-output";
import { createOptumProOutputWorkbookBuffer, completeResultsForWorkbook } from "../../scrapers/optum-pro/claim-status";
import { createWaystarOutputWorkbookBuffer } from "../../workflows/claim-status/portals/waystar/output-writer";
import type { WaystarOutputRow } from "../../workflows/claim-status/portals/waystar/types";
import { applyClaimRowUpdateToWorksheet, postProcessWorksheet } from "../../workflows/claim-status/portals/iehp/workbook-output";
import { serializeRaRecords } from "../../workflows/claim-status/portals/iehp/claims/ra";

const executionColumns: Record<string, string> = {
  availity: "bot_overall_result", iehp: "BotClaimStatusCheck", uhc: "BotStatus", aerial: "result", "all-care": "result", astrona: "result",
  "blue-shield": WORKER_OUTCOME_COLUMN, cigna: "Bot Status", kaiser: "Bot Status", "my-family": "Bot Status", "optum-pro": "Bot Status",
  physicians: "Bot Status", medpoint: "BotStatus", regal: "BotStatus", waystar: WORKER_OUTCOME_COLUMN,
};
const refs = ["A", "B", "C", "D"];
const artifact = { bucket: "test", object_key: "output.xlsx", filename: "output.xlsx", artifact_type: "output_snapshot" as const, size_bytes: 1, etag: null };

async function workbook(portal: string, rows: Array<Record<string, unknown>>) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Output");
  const headers = [...new Set(rows.flatMap(Object.keys))];
  sheet.addRow(headers);
  for (const row of rows) sheet.addRow(headers.map(header => row[header] ?? null));
  appendClaimStatusOutputColumns(sheet, portal);
  // The fixture supplies workbook-provided canonical fields, after the native
  // writer's projection. Production values are covered by output-columns.test.
  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, column) => columns.set(String(cell.value), column));
  rows.forEach((row, index) => {
    for (const header of CLAIM_STATUS_OUTPUT_HEADERS) if (Object.hasOwn(row, header)) sheet.getRow(index + 2).getCell(columns.get(header)!).value = row[header] as ExcelJS.CellValue;
  });
  return new Uint8Array(await book.xlsx.writeBuffer());
}

test("all 15 Claim Status portals dispatch to the very same worker manifest reader", () => {
  assert.equal(Object.keys(servicePortals).length, 15);
  assert.deepEqual(Object.keys(executionColumns).sort(), Object.keys(servicePortals).sort());
  for (const portal of Object.values(servicePortals)) assert.equal(portal.loadSnapshot, loadWorkerResultSnapshot);
});

test("API reads only input references and worker JSON, never portal workbooks or adjudication cells", async context => {
  const producer = createClaimResultPublisher({ jobId: "job", expectedRefs: refs, save: async () => {} });
  await producer.publishWorkbook(await workbook("availity", [{ "Client Row Ref": "C", bot_overall_result: "Success" }]), artifact);
  const keys: string[] = [];
  let missing = false;
  const send = context.mock.method(S3Client.prototype, "send", async (command: unknown) => {
    const key = (command as GetObjectCommand).input.Key!;
    keys.push(key);
    if (key === "claimRows.json") return { Body: { transformToByteArray: async () => Buffer.from(JSON.stringify(refs.map(ref => ({ "Client Row Ref": ref })))) } };
    assert.equal(key, "output/worker-results.v1.json");
    if (missing) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
    return { Body: { transformToString: async () => JSON.stringify(producer.getSnapshot()) } };
  });
  try {
    const job = { jobId: "job", inputBucket: "test", outputBucket: "test", outputPrefix: "output", claimFileName: "input.xlsx", metadata: { inputKeys: { claimRows: "claimRows.json" } } };
    for (const portal of Object.values(servicePortals)) {
      const result = await portal.loadSnapshot(job);
      assert.equal(result.summary!.finalized_count, 1);
      assert.equal(result.summary!.row_results.find(row => row.client_row_ref === "C")!.status, "SUCCESS");
    }
    missing = true;
    assert.equal((await loadWorkerResultSnapshot(job)).summary, null);
    assert.ok(keys.every(key => key.endsWith(".json")));
  } finally { send.mock.restore(); }
});

for (const [portal, column] of Object.entries(executionColumns)) {
  test(`${portal}: single shared publisher delivers A/C/D before B, retains detail rows and zero payment`, async () => {
    const native = (status: string) => column === WORKER_OUTCOME_COLUMN ? status : status === "NO_MATCH" ? "No Match" : status;
    const rows = [
      { "Client Row Ref": "A", [column]: native("SUCCESS"), "Claim Status - Paid Amount": 0, "Claim Status - Final Status": "Denied", "Claim Status - Denial Code": "CO-45" },
      { "Client Row Ref": "B", [column]: column === WORKER_OUTCOME_COLUMN ? "INCOMPLETE" : "Not processed", "Claim Status - Paid Amount": 100, "Claim Status": "Paid" },
      { "Client Row Ref": "C", [column]: native("SUCCESS"), "Claim Status - Paid Amount": 25 },
      { "Client Row Ref": "C", [column]: native("SUCCESS"), "Claim Status - Paid Amount": 50 },
      { "Client Row Ref": "D", [column]: native("NO_MATCH") },
    ];
    let saved: WorkerResultManifest | null = null;
    const producer = createClaimResultPublisher({ jobId: "job", expectedRefs: refs, save: async manifest => { saved = structuredClone(manifest); } });
    await producer.initialize();
    await producer.publishWorkbook(await workbook(portal, rows), artifact);
    const firstManifest = structuredClone(saved!);
    assert.deepEqual(firstManifest.results.map(row => row.client_row_ref), ["A", "C", "D"]);
    assert.equal(firstManifest.results[0].status, "SUCCESS"); // Denied is adjudication, not execution failure.
    assert.equal(firstManifest.results[0].result.detail_rows!.length, 1);
    assert.equal(firstManifest.results[0].result["Claim Status - Paid Amount"], 0);
    assert.equal(firstManifest.results[1].result.detail_rows!.length, 2);
    assert.equal(firstManifest.results[1].result["Claim Status - Paid Amount"], null);
    for (const result of firstManifest.results) for (const header of CLAIM_STATUS_OUTPUT_HEADERS) assert.ok(Object.hasOwn(result.result, header));

    const db = publicationDatabase();
    const pageInput = { jobId: "job", expectedRefs: refs, summary: workerManifestSummary(firstManifest, refs), cursor: 0, limit: 2, claimStatusPortal: portal };
    const first = await recordServiceResultPage(pageInput, db.pool);
    assert.deepEqual(first.results.map(row => row.client_row_ref), ["A", "C"]);
    assert.equal(first.processed, 3);
    assert.equal(first.pending, 1);
    assert.deepEqual(await recordServiceResultPage(pageInput, db.pool), first);
    const next = await recordServiceResultPage({ ...pageInput, cursor: first.nextCursor }, db.pool);
    assert.deepEqual(next.results.map(row => row.client_row_ref), ["D"]);
    assert.deepEqual((await recordServiceResultPage({ ...pageInput, cursor: next.nextCursor }, db.pool)).results, []);

    // A stale workbook cannot retract finalized results or change their payload.
    await producer.publishWorkbook(await workbook(portal, [rows[1]]), artifact);
    assert.deepEqual(producer.getSnapshot().results, firstManifest.results);
    const late = [{ ...rows[1], [column]: native("SUCCESS") }];
    await producer.publishWorkbook(await workbook(portal, late), artifact);
    const finished = await producer.finish("OUTPUT_MISSING");
    validateWorkerManifest(finished, "job", refs);
    const last = await recordServiceResultPage({ ...pageInput, summary: workerManifestSummary(finished, refs), cursor: 3, terminalStatus: "completed" }, db.pool);
    assert.deepEqual(last.results.map(row => row.client_row_ref), ["B"]);
    assert.equal(last.processed, 4);
    assert.equal(last.pending, 0);
    assert.equal(db.stored().length, 4);
  });
}

test("adjudication, arbitrary populated fields and submitted outcome markers cannot manufacture completion", async () => {
  for (const value of ["Paid", "Denied", "Pending", "In Progress", "Not processed. Job stopped.", "unknown"]) assert.equal(workerExecutionOutcome(value), "INCOMPLETE");
  for (const value of ["Member Not Found", "No Claims Found", "CPT not found in Procedures", "CPT/service dates not found in Services"]) assert.equal(workerExecutionOutcome(value), "NO_MATCH");
  const bytes = await workbook("cigna", [{ "Client Row Ref": "A", "Bot Status": "", BotStatus: "Success", [WORKER_OUTCOME_COLUMN]: "SUCCESS", "Claim Status": "Paid", "Claim Status - Paid Amount": 999 }]);
  assert.deepEqual(await completedWorkerWorkbookResults(bytes, ["A"]), []);
});

test("UHC does not propagate completion to another client reference sharing member/date", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Claims");
  sheet.addRows([["Client Row Ref", "Group", "Subscriber ID", "DOS", "CPT"], ["A", "group", "member", "01/01/2026", "99213"], ["B", "group", "member", "01/01/2026", "99214"]]);
  applyUhcRowUpdateToWorksheet(sheet, { rowIndex: 3, update: { BotStatus: "Success", BotClaimStatus: "Paid", BotPaidAmount: "25" } });
  postProcessUhcWorksheet(sheet);
  const completed = await completedWorkerWorkbookResults(new Uint8Array(await book.xlsx.writeBuffer()), ["A", "B"]);
  assert.deepEqual(completed.map(row => row.client_row_ref), ["B"]);
});

test("a real Optum workbook with 359 placeholder rows publishes only the 17 explicit worker completions", async () => {
  const input = Array.from({ length: 359 }, (_, index) => ({ rowNumber: index + 2, raw: { "Client Row Ref": `R${index}` },
    medicalGroupName: "test", patient: "test", dos: "01/01/2026", cpt: "99213", memberId: "test" }));
  const outcomes = completeResultsForWorkbook(input, input.map(() => null), false);
  for (let index = 0; index < 17; index++) outcomes[index * 7].status = "Completed";
  const completed = await completedWorkerWorkbookResults(await createOptumProOutputWorkbookBuffer(outcomes), input.map(row => String(row.raw["Client Row Ref"])));
  assert.equal(completed.length, 17);
  assert.ok(completed.every(row => row.status === "SUCCESS"));
});

test("Waystar continuation detail rows map to one claim, and payer status alone is insufficient", async () => {
  const outputRows = [
    { sno: "1.", status: "paid", workerOutcome: "SUCCESS", provPd: "0" },
    { sno: "", status: "denial", workerOutcome: "SUCCESS", provPd: "0" },
    { sno: "2.", status: "paid" },
  ] as WaystarOutputRow[];
  const completed = await completedWorkerWorkbookResults(await createWaystarOutputWorkbookBuffer({ outputRows, errorRows: [], auditRows: [] }), ["A", "B"]);
  assert.deepEqual(completed.map(row => row.client_row_ref), ["A"]);
  assert.equal(completed[0].result.detail_rows!.length, 2);
  assert.equal(completed[0].result["Claim Status - Paid Amount"], "0");
});

test("Waystar error-only snapshots retain one-based correlation even with zero completed output rows", async () => {
  const bytes = await createWaystarOutputWorkbookBuffer({ outputRows: [], auditRows: [], errorRows: [
    { timestamp: "test", inputRowId: 2, patientName: "test", responsiblePayer: "test", dos: "01/01/2026", errorType: "portal", errorMessage: "Portal Error" },
  ] });
  const completed = await completedWorkerWorkbookResults(bytes, ["A", "B"]);
  assert.deepEqual(completed.map(row => [row.client_row_ref, row.status]), [["B", "FAILED"]]);
});

test("IEHP native RA output retains single-row details, denial codes and zero net payment in the common publisher", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Claims");
  sheet.addRows([["Client Row Ref", "CPT"], ["A", "99213"], ["B", "99214"]]);
  applyClaimRowUpdateToWorksheet(sheet, { index: 1, update: { BotClaimStatusCheck: "Success", BotClaimStatusCheckError: "", BotReferRA: serializeRaRecords([
    { CheckNumber: "test", RACheckAmount: "9000", RAProcCode: "99214", RAAmountBilled: "100", RAAmountAllowed: "0", RACopay: "0", RACoins: "0", RADeductAmount: "0", RANetPaid: "0", RAStatus: "Denied", RAReason: "CO-45", RADenialReason: "CO-45 - Denied" },
  ]) } });
  postProcessWorksheet(sheet);
  const results = await completedWorkerWorkbookResults(new Uint8Array(await book.xlsx.writeBuffer()), ["A", "B"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].client_row_ref, "B");
  assert.equal(results[0].status, "SUCCESS");
  assert.equal(results[0].result.detail_rows!.length, 1);
  assert.equal(results[0].result["Claim Status - Paid Amount"], 0);
  assert.equal(results[0].result["Claim Status - Denial Code"], "CO-45");
});

test("reusing an IEHP/UHC workbook cannot inherit a prior execution's success", async () => {
  for (const portal of ["iehp", "uhc"]) {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Claims");
    sheet.addRows([["Client Row Ref", executionColumns[portal], WORKER_OUTCOME_COLUMN, "BotClaimDetails", ...CLAIM_STATUS_OUTPUT_HEADERS], ["A", "Success", "SUCCESS", "old details", "old", "old", 999, "old", "Paid"]]);
    clearPreviousWorkerOutput(sheet);
    appendClaimStatusOutputColumns(sheet, portal);
    assert.equal(sheet.getRow(2).getCell(1).value, "A");
    assert.deepEqual(await completedWorkerWorkbookResults(new Uint8Array(await book.xlsx.writeBuffer()), ["A"]), []);
  }
});

test("an unfinished detail row prevents freezing only that claim", async () => {
  const bytes = await workbook("iehp", [{ "Client Row Ref": "A", BotClaimStatusCheck: "Success" }, { "Client Row Ref": "A", BotClaimStatusCheck: "" }, { "Client Row Ref": "B", BotClaimStatusCheck: "Success" }]);
  assert.deepEqual((await completedWorkerWorkbookResults(bytes, ["A", "B"])).map(row => row.client_row_ref), ["B"]);
});

test("terminal status alone cannot publish claims; the shared producer explicitly closes missing/cancelled refs", async () => {
  assert.deepEqual(planServiceResultPublications([], { expectedRefs: refs, summary: null, terminalStatus: "failed", claimStatusPortal: "availity" }), []);
  const producer = createClaimResultPublisher({ jobId: "job", expectedRefs: refs, save: async () => {} });
  await producer.publishWorkbook(await workbook("availity", [{ "Client Row Ref": "C", bot_overall_result: "Skipped", bot_notes: "Unsupported payer" }]), artifact);
  const final = await producer.finish("CANCELLED");
  assert.equal(final.results.find(row => row.client_row_ref === "C")!.status, "SKIPPED");
  assert.equal(final.results.find(row => row.client_row_ref === "C")!.error_category, "UNSUPPORTED_PAYER");
  assert.ok(final.results.filter(row => row.client_row_ref !== "C").every(row => row.status === "FAILED" && row.error_category === "CANCELLED"));
  validateWorkerManifest(final, "job", refs);
  await producer.publishWorkbook(await workbook("availity", [{ "Client Row Ref": "A", bot_overall_result: "Success" }]), artifact);
  assert.deepEqual(producer.getSnapshot(), final);
  assert.throws(() => validateWorkerManifest(final, "another-job", refs));
  assert.throws(() => validateWorkerManifest({ ...final, results: [...final.results, final.results[0]] }, "job", refs));
  assert.throws(() => validateWorkerManifest({ ...final, results: [{ ...final.results[0], status: "SUCCESS" }] }, "job", refs));
});

test("skipped details keep their own claim outcome despite diagnostic error rows; mixed groups never become success", async () => {
  assert.equal(workerExecutionOutcome("Skipped"), "SKIPPED");
  assert.equal(workerExecutionOutcome("SKIPPED - unsupported payer"), "SKIPPED");
  const book = new ExcelJS.Workbook();
  const bytes = await workbook("availity", [
    { "Client Row Ref": "A", bot_overall_result: "Skipped", bot_notes: "Unsupported payer" },
    { "Client Row Ref": "A", bot_overall_result: "Skipped", bot_notes: "Unsupported payer" },
    { "Client Row Ref": "B", bot_overall_result: "Success" },
    { "Client Row Ref": "B", bot_overall_result: "Skipped" },
    { "Client Row Ref": "C", bot_overall_result: "Skipped" },
    { "Client Row Ref": "C", bot_overall_result: "Not processed" },
  ]);
  await book.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const errors = book.addWorksheet("Error Log");
  errors.addRow(["Client Row Ref", "error_message"]);
  errors.addRow(["A", "Unsupported payer"]);
  const results = await completedWorkerWorkbookResults(new Uint8Array(await book.xlsx.writeBuffer()), refs);
  assert.deepEqual(results.map(row => [row.client_row_ref, row.status]), [["A", "SKIPPED"], ["B", "FAILED"]]);
  assert.equal(results[0].result.detail_rows?.length, 3);
  assert.equal(results[0].error_category, "UNSUPPORTED_PAYER");
  const summary = workerManifestSummary({ version: 1, producer: "claim-status-worker", job_id: "job", results, artifact, finalized: false }, refs);
  assert.equal(summary.counts.skipped, 1);
  assert.equal(summary.counts.failed, 1);
});

test("worker saves serialize, preserve immutable results across restart, and retry a failed manifest write", async () => {
  const saves: WorkerResultManifest[] = [];
  let fail = true;
  const producer = createClaimResultPublisher({ jobId: "job", expectedRefs: refs, save: async manifest => {
    if (fail) { fail = false; throw new Error("temporary storage failure"); }
    saves.push(structuredClone(manifest));
  } });
  await assert.rejects(producer.publishWorkbook(await workbook("regal", [{ "Client Row Ref": "D", BotStatus: "Success" }]), artifact), /temporary/);
  assert.equal(producer.getSnapshot().results.length, 0); // Failed writes cannot inflate published progress.
  await Promise.all([
    producer.publishWorkbook(await workbook("regal", [{ "Client Row Ref": "B", BotStatus: "Success" }]), artifact),
    producer.publishWorkbook(await workbook("regal", [{ "Client Row Ref": "A", BotStatus: "Success" }]), artifact),
  ]);
  assert.deepEqual(saves.map(save => save.results.length), [2, 3]);
  const restored = createClaimResultPublisher({ jobId: "job", expectedRefs: refs, initial: saves.at(-1), save: async () => {} });
  await restored.publishWorkbook(await workbook("regal", [{ "Client Row Ref": "D", BotStatus: "Failed" }]), artifact);
  assert.equal(restored.getSnapshot().results.find(row => row.client_row_ref === "D")!.status, "SUCCESS");
});
