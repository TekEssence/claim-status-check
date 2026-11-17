import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { normalizeAvailityServiceWorkbook } from "./availity-results";
import { normalizeIehpServiceWorkbook } from "./iehp-results";
import { normalizeGenericClaimStatusWorkbook } from "./generic-claim-status-results";
import { normalizeEligibilityServiceWorkbook } from "./eligibility-results";
import { claimStatusServicePortalConfigs, type GenericClaimStatusServicePortalId } from "./generic-claim-status-input";
import { summarizeServiceResults, incompleteServiceResult } from "./result-summary";
import { planServiceResultPublications, ServicePublicationError } from "./result-publication";
import { recordServiceResultPage } from "./result-publication-store";
import { publicationDatabase } from "./result-publication-test-helpers";
import type { ServiceRowResult } from "./service-contract";
import type { Pool } from "pg";

const refs = ["A", "B", "C", "D"];
const success = (ref: string): ServiceRowResult => ({ client_row_ref: ref, status: "SUCCESS", result: { claim_status: "Paid", claim_details: `Result ${ref}` }, error_category: null, error_message: null });
const summaryFor = (finished: string[], all = refs) => summarizeServiceResults(all.map(ref => finished.includes(ref) ? success(ref) : incompleteServiceResult(ref)));

type Portal = "availity" | "iehp" | "eligibility" | GenericClaimStatusServicePortalId;
const portals: Portal[] = ["availity", "iehp", ...Object.keys(claimStatusServicePortalConfigs) as GenericClaimStatusServicePortalId[], "eligibility"];

async function workbookSummary(portal: Portal, finished: string[], withDetails = false) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet(portal === "iehp" ? "Claims" : "Output");
  const columns = portal === "availity" ? ["Client Row Ref", "bot_overall_result", "bot_updated_claim_status", "Member ID"]
    : portal === "iehp" ? ["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails", "Member ID"]
      : portal === "eligibility" ? ["Client Row Ref", "Coverage Status"] : ["Client Row Ref", "Bot Status", "Final Status", "Member ID"];
  sheet.addRow(columns);
  for (const ref of finished) {
    const add = () => sheet.addRow(portal === "iehp" ? [ref, "Success", "", `Detail ${ref}`, "SAME-MEMBER"]
      : portal === "eligibility" ? [ref, "active"] : [ref, "success", `Detail ${ref}`, "SAME-MEMBER"]);
    add();
    if (withDetails && ref === "A" && portal !== "eligibility") add();
  }
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  if (portal === "availity") return normalizeAvailityServiceWorkbook(bytes, refs);
  if (portal === "iehp") return normalizeIehpServiceWorkbook(bytes, refs, { requireStatusColumns: false });
  if (portal === "eligibility") return normalizeEligibilityServiceWorkbook(bytes, refs, { requireStatusColumns: false });
  return normalizeGenericClaimStatusWorkbook(bytes, refs, portal);
}

for (const portal of portals) {
  test(`${portal}: publish A/C/D, replay pages, then append delayed B without duplicates`, async () => {
    const db = publicationDatabase();
    const summary = await workbookSummary(portal, ["D", "A", "C"], true);
    assert.equal(summary.finalized_count, 3);
    assert.equal(summary.counts.incomplete, 1);
    const input = { jobId: "job", expectedRefs: refs, summary, cursor: 0, limit: 2 };
    const first = await recordServiceResultPage(input, db.pool);
    assert.deepEqual(first.results.map(row => row.client_row_ref), ["A", "C"]);
    assert.deepEqual({ processed: first.processed, pending: first.pending, cursor: first.nextCursor }, { processed: 3, pending: 1, cursor: 2 });
    if (portal !== "eligibility") assert.equal(first.results[0].result.detail_rows?.length, 2);
    assert.deepEqual(await recordServiceResultPage(input, db.pool), first);
    const second = await recordServiceResultPage({ ...input, cursor: first.nextCursor }, db.pool);
    assert.deepEqual(second.results.map(row => row.client_row_ref), ["D"]);
    const lateSummary = await workbookSummary(portal, ["A", "B", "C", "D"], true);
    const late = await recordServiceResultPage({ ...input, summary: lateSummary, cursor: second.nextCursor }, db.pool);
    assert.deepEqual(late.results.map(row => row.client_row_ref), ["B"]);
    assert.deepEqual({ processed: late.processed, pending: late.pending, cursor: late.nextCursor }, { processed: 4, pending: 0, cursor: 4 });
    const drained = await recordServiceResultPage({ ...input, summary: lateSummary, cursor: 4, terminalStatus: "completed" }, db.pool);
    assert.deepEqual(drained.results, []);
    assert.equal(drained.nextCursor, 4);
    const replay = await recordServiceResultPage({ ...input, summary: lateSummary }, db.pool);
    assert.deepEqual(replay.results, first.results);
    assert.deepEqual(db.stored().map(row => row.client_row_ref), ["A", "C", "D", "B"]);
    assert.equal(new Set([...first.results, ...second.results, ...late.results].map(row => row.client_row_ref)).size, 4);
  });
}

test("concurrent pollers serialize sequence allocation and retain one entry per reference", async () => {
  const db = publicationDatabase();
  const base = { jobId: "job", expectedRefs: refs, cursor: 0, limit: 2 };
  await Promise.all([
    recordServiceResultPage({ ...base, summary: summaryFor(["A", "C"]) }, db.pool),
    recordServiceResultPage({ ...base, summary: summaryFor(["A", "C", "D"]) }, db.pool),
    recordServiceResultPage({ ...base, summary: summaryFor(["A", "B", "C", "D"]) }, db.pool),
  ]);
  assert.deepEqual(db.stored().map(row => row.sequence), [1, 2, 3, 4]);
  assert.equal(new Set(db.stored().map(row => row.client_row_ref)).size, 4);
  assert.ok(db.queries.findIndex(sql => sql.includes("FOR UPDATE")) < db.queries.findIndex(sql => sql.startsWith("SELECT sequence")));
});

test("a response lost after commit is replayed without allocating duplicate publications", async () => {
  const db = publicationDatabase();
  const input = { jobId: "job", expectedRefs: refs, summary: summaryFor(["A", "C", "D"]), cursor: 0, limit: 2 };
  db.loseNextCommitResponse();
  await assert.rejects(recordServiceResultPage(input, db.pool), /Commit response lost/);
  assert.equal(db.stored().length, 3);
  const retry = await recordServiceResultPage(input, db.pool);
  assert.deepEqual(retry.results.map(row => row.client_row_ref), ["A", "C"]);
  assert.equal(db.stored().length, 3);
});

test("stale or absent snapshots cannot remove publications, regress progress or mutate payloads", async () => {
  const db = publicationDatabase();
  const input = { jobId: "job", expectedRefs: refs, summary: summaryFor(["A", "C", "D"]), cursor: 0, limit: 100 };
  const initial = await recordServiceResultPage(input, db.pool);
  const stale = await recordServiceResultPage({ ...input, summary: summaryFor(["A"]) }, db.pool);
  assert.deepEqual(stale, initial);
  const absent = await recordServiceResultPage({ ...input, summary: null }, db.pool);
  assert.deepEqual(absent, initial);
  const changed = summaryFor(["A", "C", "D"]);
  changed.row_results[0].result.claim_details = "Later workbook rewrite";
  assert.deepEqual((await recordServiceResultPage({ ...input, summary: changed }, db.pool)).results, initial.results);
});

test("terminal failures/cancellation explicitly finalize every remaining ref while preserving recorded results", async () => {
  for (const terminalStatus of ["failed", "cancelled", "partial_success"]) {
    const db = publicationDatabase();
    const input = { jobId: "job", expectedRefs: refs, summary: summaryFor(["C"]), cursor: 0, limit: 100 };
    const first = await recordServiceResultPage(input, db.pool);
    assert.deepEqual(first.results.map(row => row.client_row_ref), ["C"]);
    const last = await recordServiceResultPage({ ...input, summary: null, terminalStatus, cursor: 1 }, db.pool);
    assert.deepEqual(last.results.map(row => row.client_row_ref), ["A", "B", "D"]);
    assert.ok(last.results.every(row => row.status === "FAILED" && row.error_category === (terminalStatus === "cancelled" ? "CANCELLED" : "OUTPUT_MISSING")));
    assert.equal(last.processed, 4);
    assert.equal(last.pending, 0);
    assert.deepEqual((await recordServiceResultPage({ ...input, terminalStatus, cursor: 4 }, db.pool)).results, []);
  }
});

test("an empty poll does not reserve a cursor position; a later completion is returned there", async () => {
  const db = publicationDatabase();
  const input = { jobId: "job", expectedRefs: refs, summary: summaryFor([]), cursor: 0, limit: 100 };
  assert.equal((await recordServiceResultPage(input, db.pool)).nextCursor, 0);
  const later = await recordServiceResultPage({ ...input, summary: summaryFor(["D"]) }, db.pool);
  assert.deepEqual(later.results.map(row => row.client_row_ref), ["D"]);
  assert.equal(later.nextCursor, 1);
});

test("partially written detail groups wait for all their details without blocking other refs", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Claims");
  sheet.addRow(["Client Row Ref", "BotClaimStatusCheck", "BotClaimStatusCheckError", "BotClaimDetails"]);
  sheet.addRow(["A", "Success", "", "First detail"]);
  sheet.addRow(["A", "", "", "Second detail pending"]);
  sheet.addRow(["D", "Success", "", "Other claim done"]);
  const parse = async () => normalizeIehpServiceWorkbook(new Uint8Array(await book.xlsx.writeBuffer()), refs, { requireStatusColumns: false });
  const db = publicationDatabase();
  const first = await recordServiceResultPage({ jobId: "job", expectedRefs: refs, summary: await parse(), cursor: 0, limit: 100 }, db.pool);
  assert.deepEqual(first.results.map(row => row.client_row_ref), ["D"]);
  sheet.getRow(3).getCell(2).value = "Success";
  const later = await recordServiceResultPage({ jobId: "job", expectedRefs: refs, summary: await parse(), cursor: first.nextCursor, limit: 100 }, db.pool);
  assert.deepEqual(later.results.map(row => row.client_row_ref), ["A"]);
  assert.equal(later.results[0].result.detail_rows?.length, 2);
});

test("legacy numeric prefix cursors continue safely when the publication ledger is first initialized", async () => {
  const db = publicationDatabase();
  const page = await recordServiceResultPage({ jobId: "job", expectedRefs: refs, summary: summaryFor(["A", "C", "D"]), cursor: 1, limit: 100 }, db.pool);
  assert.deepEqual(page.results.map(row => row.client_row_ref), ["C", "D"]);
  assert.equal(page.nextCursor, 3);
});

test("1,279 submitted refs with scattered completions publish all completed claims, not one", async () => {
  const all = Array.from({ length: 1279 }, (_, i) => `claim-${i + 1}`);
  const positions = [1, 22, 28, 33, 50, 74, 75, 132, 160, 164, 191, 194];
  const db = publicationDatabase();
  const page = await recordServiceResultPage({ jobId: "job", expectedRefs: all, summary: summaryFor(positions.map(i => all[i - 1]), all), cursor: 0, limit: 100 }, db.pool);
  assert.equal(page.processed, 12);
  assert.equal(page.pending, 1267);
  assert.equal(page.results.length, 12);
  assert.equal(page.nextCursor, 12);
  const second = await recordServiceResultPage({ jobId: "job", expectedRefs: all, summary: summaryFor([...positions, 2].map(i => all[i - 1]), all), cursor: 12, limit: 100 }, db.pool);
  assert.deepEqual(second.results.map(row => row.client_row_ref), ["claim-2"]);
});

test("publication validation rolls back unexpected/duplicate refs and invalid cursor progression", async () => {
  const db = publicationDatabase();
  const input = { jobId: "job", expectedRefs: refs, summary: summaryFor(["A"]), cursor: 0, limit: 100 };
  for (const row_results of [[success("unexpected")], [success("A"), success("A")]]) {
    await assert.rejects(recordServiceResultPage({ ...input, summary: { ...input.summary, row_results } }, db.pool), ServicePublicationError);
    assert.deepEqual(db.stored(), []);
  }
  await assert.rejects(recordServiceResultPage({ ...input, cursor: 4 }, db.pool), ServicePublicationError);
  assert.deepEqual(db.stored(), []);
  assert.deepEqual(planServiceResultPublications([], { expectedRefs: refs, summary: input.summary }).map(row => row.client_row_ref), ["A"]);
});

test("unsupported payers are explicit finalized failures included in submitted totals", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Output");
  sheet.addRow(["Client Row Ref", "bot_overall_result", "bot_notes"]);
  sheet.addRow(["D", "skipped", 'Payer "MFA fixture payer" is not supported now. This row was skipped.']);
  const summary = await normalizeAvailityServiceWorkbook(new Uint8Array(await book.xlsx.writeBuffer()), refs, { requireStatusColumns: false });
  const db = publicationDatabase();
  const page = await recordServiceResultPage({ jobId: "job", expectedRefs: refs, summary, cursor: 0, limit: 100 }, db.pool);
  assert.equal(page.unsupported, 1);
  assert.equal(page.processed, 1);
  assert.equal(page.pending, 3);
  assert.equal(page.results[0].status, "FAILED");
  assert.equal(page.results[0].error_category, "UNSUPPORTED_PAYER");
});

test("a nonterminal state cannot finalize missing rows and invalid page arguments are rejected", async () => {
  assert.throws(() => planServiceResultPublications([], { expectedRefs: refs, summary: null, terminalStatus: "running" }), ServicePublicationError);
  const db = publicationDatabase();
  for (const args of [{ cursor: -1, limit: 100 }, { cursor: 0, limit: 0 }, { cursor: 0, limit: 201 }]) {
    await assert.rejects(recordServiceResultPage({ jobId: "job", expectedRefs: refs, summary: null, ...args }, db.pool), ServicePublicationError);
  }
  assert.deepEqual(db.queries, []);
});

test("a missing publication migration returns a clear retryable error without recording results", async () => {
  const db = publicationDatabase();
  const pool = { connect: async () => {
    const client = await db.pool.connect();
    return { release: () => client.release(), query: async (sql: string, args?: unknown[]) => {
      if (sql.includes("workflow_service_results")) throw Object.assign(new Error("Relation unavailable"), { code: "42P01" });
      return client.query(sql, args);
    } };
  } } as unknown as Pick<Pool, "connect">;
  await assert.rejects(recordServiceResultPage({ jobId: "job", expectedRefs: refs, summary: summaryFor(["A"]), cursor: 0, limit: 100 }, pool),
    error => error instanceof ServicePublicationError && error.statusCode === 503 && /0008/.test(error.message));
  assert.deepEqual(db.stored(), []);
  assert.ok(db.queries.includes("ROLLBACK"));
});
