import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { getAutomationRunner } from "../../workflows/registry";
import { createEligibilityServiceSnapshots } from "../../workflows/eligibility-verification/partial-output";
import type { EligibilityInputRow, EligibilityResult } from "../../workflows/eligibility-verification/types";
import { buildHealthNetOutput } from "../../workflows/eligibility-verification/portals/healthnet/data";
import { buildIehpOutput } from "../../workflows/eligibility-verification/portals/iehp/data";
import { buildMediCalOutput } from "../../workflows/eligibility-verification/portals/medi-cal/data";
import { buildTriZettoOutput } from "../../workflows/eligibility-verification/portals/trizetto/data";
import { buildWaystarOutputWorkbook } from "../../workflows/eligibility-verification/portals/waystar/output";
import { readWaystarCredentialProfiles } from "../../workflows/eligibility-verification/portals/waystar/credentials";
import { ELIGIBILITY_SERVICE_PORTALS, eligibilityServiceOutputFilenames, eligibilityServiceProject, type EligibilityServicePortal } from "./eligibility-portals";
import { readUhcEligibilityCredentials } from "../../workflows/eligibility-verification/portals/uhc/credentials";
import { readUhcEligibilityInputRows, runUhcWellmedEligibilityWorkflow, UHC_OUTPUT_HEADERS } from "../../workflows/eligibility-verification/portals/uhc/payers/uhc-wellmed/workflow";
import { getServiceWorkflow, resolveServiceWorkflowRoute } from "./workflow-registry";
import { normalizeEligibilityServiceWorkbook } from "./eligibility-results";
import { publicationDatabase } from "./result-publication-test-helpers";
import { publishServiceResultPage, readWorkerServiceResultPage } from "./result-publication-store";
import { finalizeStoppedServiceJob } from "./service-cancellation-finalizer";

const credentials = { login_url: "https://example.test/login", username: "integration-user", password: "test-password" };
const refs = ["A", "B", "C"];
const payers = { availity: "Molina", healthnet: "Health Net", iehp: "IEHP", medical: "Medi-Cal", trizetto: "Aetna", waystar: "Aetna" };
const medRevenuePortals = ELIGIBILITY_SERVICE_PORTALS.filter(portal => portal !== "uhc");
const data = (portal: Exclude<EligibilityServicePortal, "uhc">) => ({ "Primary Insurance Name": payers[portal], "Patient Name": "Example, Jane",
  "Member ID": "M001", DOB: "01/02/1990", DOS: "10/20/2026" });
const request = (portal: Exclude<EligibilityServicePortal, "uhc">) => ({ projectId: "medrevenue", credentials,
  claims: refs.map(ref => ({ client_row_ref: ref, data: data(portal) })) });
const build = { healthnet: buildHealthNetOutput, iehp: buildIehpOutput, medical: buildMediCalOutput, trizetto: buildTriZettoOutput,
  waystar: (input: Parameters<typeof buildWaystarOutputWorkbook>[0]) => buildWaystarOutputWorkbook({ ...input, projectId: "medrevenue" }),
  availity: (input: Parameters<typeof buildWaystarOutputWorkbook>[0]) => buildWaystarOutputWorkbook({ ...input, projectId: "medrevenue" }) };
const result = (index: number): EligibilityResult => ({ rowIndex: index, payerId: "aetna", coverageStatus: "active", benefits: [],
  planName: "Portal plan", coverageDescription: "Verified coverage", ipa: "Portal IPA", metadata: { trizettoDescription: "Portal description" } });

for (const portal of medRevenuePortals) {
  test(`${portal}: service inputs reach the existing native runner and preserve references`, async () => {
    const prepared = await getServiceWorkflow("ELIGIBILITY")!.portals[portal].prepare(request(portal));
    const form = new FormData();
    for (const [key, value] of Object.entries(prepared.formFields)) form.set(key, value);
    for (const file of prepared.files) form.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
    const input = getAutomationRunner("eligibility-verification", portal).validateInput(form) as { projectId: string };
    assert.equal(input.projectId, "medrevenue");
    assert.deepEqual(JSON.parse(prepared.claimRowsJson).map((row: Record<string, string>) => row["Client Row Ref"]), refs);
    assert.ok(!prepared.claimRowsJson.includes(credentials.password));
  });

  test(`${portal}: native snapshots publish once, append late results, and recover cancellation without losing outcomes`, async () => {
    const prepared = await getServiceWorkflow("ELIGIBILITY")!.portals[portal].prepare(request(portal));
    const inputFile = new File([new Uint8Array(prepared.files[0].buffer)], "input.xlsx");
    const rows = new Map(refs.map((ref, index) => [index + 2, { originalIndex: index + 2, raw: { "Client Row Ref": ref } } as EligibilityInputRow]));
    const results = new Map([[2, result(2)]]); const errors = new Map<number, string>();
    const db = publicationDatabase(refs);
    db.setJobState({ workflow_id: "eligibility-verification", ecs_task_arn: "task", metadata: { serviceClaimRefs: refs, expectedRowCount: refs.length } });
    const filename = eligibilityServiceOutputFilenames(portal)[0];
    const artifact = { bucket: "output", object_key: "job/output/result.xlsx", filename, size_bytes: 1, etag: null, artifact_type: "output_snapshot" as const };
    let now = Date.now(); const originalNow = Date.now;
    let bytes: Uint8Array | undefined;
    let writes = 0;
    const snapshot = createEligibilityServiceSnapshots({ jobId: "job", workflowId: "eligibility-verification", portalId: portal,
      emit: async () => {}, log: async () => {}, saveServiceResults: async output => {
        writes++; bytes = output;
        const summary = await normalizeEligibilityServiceWorkbook(output, refs, { requireStatusColumns: false, unfinishedAsPending: true });
        await publishServiceResultPage({ jobId: "job", expectedRefs: refs, summary, cursor: 0, limit: 1,
          workerState: { artifact, finalized: summary.counts.incomplete === 0 } }, db.pool);
      },
    }, { inputFile, rows, results, errors }, build[portal]);
    try {
      Date.now = () => now;
      await snapshot();
      let page = await readWorkerServiceResultPage("job", 0, 1, db.pool);
      assert.deepEqual([page.processed, page.pending, page.results[0].status], [1, 2, "SUCCESS"]);
      const saved = db.stored()[0];
      await snapshot(); assert.equal(writes, 1);
      results.set(4, result(4)); now += 11_000;
      await snapshot();
      page = await readWorkerServiceResultPage("job", 1, 1, db.pool);
      assert.equal(page.results[0].client_row_ref, "C"); assert.equal(page.nextCursor, 2);
      assert.deepEqual(db.stored()[0], saved);
      assert.deepEqual(await readWorkerServiceResultPage("job", 1, 1, db.pool), page);
      db.setJobState({ status: "cancelling" });
      type Job = Parameters<typeof finalizeStoppedServiceJob>[0];
      const current = () => ({ jobId: "job", workflowId: "eligibility-verification", portalId: portal, clientSystem: "AR_WORKFLOW",
        status: db.jobState().status, ecsTaskArn: "task", currentCompleted: db.progress()?.completed, totalRows: refs.length,
        metadata: db.jobState().metadata } as Job);
      const deps: NonNullable<Parameters<typeof finalizeStoppedServiceJob>[2]> = {
        find: async () => current(), refs: async () => refs,
        snapshot: async () => { throw new Error("Claim Status snapshots must not be read."); },
        artifacts: async () => [], discover: async () => [artifact], workbook: async () => bytes!,
        publish: async () => { throw new Error("Claim Status publisher must not be used."); },
        publishEligibility: input => publishServiceResultPage(input, db.pool), notify: async () => 1, notifyStopped: async () => 1,
      };
      await finalizeStoppedServiceJob(current(), { taskArn: "task", lastStatus: "STOPPED", containers: [{ name: "worker", exitCode: 137 }] }, deps);
      const finalPage = await readWorkerServiceResultPage("job", 2, 1, db.pool);
      assert.deepEqual([finalPage.results[0].client_row_ref, finalPage.results[0].error_category, finalPage.pending, finalPage.nextCursor], ["B", "CANCELLED", 0, 3]);
      assert.deepEqual(db.stored()[0], saved);
    } finally { Date.now = originalNow; }
  });
}

test("new portals reuse native input aliases and reject rows filtered by their portal", async () => {
  for (const portal of ["healthnet", "iehp", "medical"] as const) {
    const body = request(portal);
    const alias = { "Primary Insurance Name": payers[portal], "Subscriber Name": "Example, Jane", "Subscriber ID": "M001",
      "Date of Birth": "01/02/1990", "Date of Service": "10/20/2026" };
    await getServiceWorkflow("ELIGIBILITY")!.portals[portal].prepare({ ...body, claims: [{ client_row_ref: "alias", data: alias }] });
    await assert.rejects(getServiceWorkflow("ELIGIBILITY")!.portals[portal].prepare({ ...body,
      claims: [{ client_row_ref: "filtered", data: { ...data(portal), "Primary Insurance Name": "Unsupported payer" } }] }), /does not select every submitted claim/);
  }
});

test("native active/inactive coverage and no-match errors keep the same result meanings across portals", async () => {
  for (const portal of medRevenuePortals) {
    const prepared = await getServiceWorkflow("ELIGIBILITY")!.portals[portal].prepare(request(portal));
    const inputFile = new File([new Uint8Array(prepared.files[0].buffer)], "input.xlsx");
    const rows = new Map(refs.map((ref, index) => [index + 2, { originalIndex: index + 2, raw: { "Client Row Ref": ref } } as EligibilityInputRow]));
    const bytes = await build[portal]({ inputFile, rows, results: new Map([[2, result(2)], [3, { ...result(3), coverageStatus: "inactive" }]]),
      errors: new Map([[4, "Subscriber not found"]]) });
    const summary = await normalizeEligibilityServiceWorkbook(bytes, refs, { unfinishedAsPending: true });
    assert.deepEqual(summary.row_results.map(row => [row.status, row.result.coverage_status]), [["SUCCESS", "active"], ["SUCCESS", "inactive"], ["NO_MATCH", null]], portal);
    assert.equal(summary.counts.incomplete, 0);
  }
});

test("Waystar retains payer credentials, provider settings and security answers; ambiguous projects stay unintegrated", async () => {
  const adapter = getServiceWorkflow("ELIGIBILITY")!.portals.waystar;
  const prepared = await adapter.prepare({ ...request("waystar"), credentials: { accounts: [
    { ...credentials, payer: "Aetna", provider_id: "provider-1", service_type_code: "30", verification_answers: [{ question: "Test question?", answer: "Test answer" }] },
  ] } });
  const profiles = await readWaystarCredentialProfiles(new File([new Uint8Array(prepared.files[1].buffer)], "login.xlsx"));
  assert.deepEqual([profiles[0].payer, profiles[0].providerId, profiles[0].serviceTypeCode, profiles[0].verificationAnswers[0].answer], ["Aetna", "provider-1", "30", "Test answer"]);
  await assert.rejects(adapter.prepare({ ...request("waystar"), credentials: { ...credentials, payer: "Unrelated payer" } }), /do not cover every requested payer/);
  assert.throws(() => resolveServiceWorkflowRoute("ELIGIBILITY", "noridian"), /not supported/);
  await assert.rejects(adapter.prepare({ ...request("waystar"), projectId: "minimax" }), /projectId/);
});

test("UHC service accepts Minimax, reuses native input/credentials and rejects MedRevenue", async () => {
  const adapter = getServiceWorkflow("ELIGIBILITY")!.portals.uhc;
  const body = { projectId: "minimax", credentials: { ...credentials, totp_secret: "DUMMYBASE32SECRET" },
    claims: [{ client_row_ref: "uhc-A", data: { "Member ID": "U001", "Date of Birth": "01/01/1950" } }] };
  const prepared = await adapter.prepare(body);
  assert.equal(prepared.formFields.projectId, "minimax");
  assert.equal(eligibilityServiceProject("uhc"), "minimax");
  const form = new FormData();
  for (const [key, value] of Object.entries(prepared.formFields)) form.set(key, value);
  for (const file of prepared.files) form.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
  const input = getAutomationRunner("eligibility-verification", "uhc").validateInput(form) as { inputFile: File; credentialFile: File; projectId: string };
  assert.equal(input.projectId, "minimax");
  assert.equal((await readUhcEligibilityCredentials(input.credentialFile, "minimax")).totpSecret, body.credentials.totp_secret);
  const book = new ExcelJS.Workbook(); await book.xlsx.load(await input.inputFile.arrayBuffer());
  const routing = readUhcEligibilityInputRows(book.worksheets[0]);
  assert.deepEqual(routing.rows.map(row => row.memberId), ["U001"]);
  assert.deepEqual(JSON.parse(prepared.claimRowsJson).map((row: Record<string, string>) => row["Client Row Ref"]), ["uhc-A"]);
  for (const projectId of ["medrevenue", "medrevenu"]) await assert.rejects(adapter.prepare({ ...body, projectId }), /projectId must be "minimax"/);
  await assert.rejects(adapter.prepare({ ...body, credentials }), /totp_secret/);
});

test("UHC native workbook publishes errors immediately and preserves its first-sheet format", async () => {
  const body = { projectId: "minimax", credentials: { ...credentials, totp_secret: "DUMMYBASE32SECRET" },
    claims: refs.map(ref => ({ client_row_ref: ref, data: { Payer: "Unsupported payer", "Member ID": ref, DOB: "01/01/1950" } })) };
  const prepared = await getServiceWorkflow("ELIGIBILITY")!.portals.uhc.prepare(body);
  const inputFile = new File([new Uint8Array(prepared.files[0].buffer)], "input.xlsx");
  let snapshot: Uint8Array | undefined; let final: Uint8Array | undefined;
  await runUhcWellmedEligibilityWorkflow({ inputFile, page: {} as Parameters<typeof runUhcWellmedEligibilityWorkflow>[0]["page"],
    context: { jobId: "uhc-service-input-test", workflowId: "eligibility-verification", portalId: "uhc", log: async () => {},
      saveServiceResults: async bytes => { snapshot = bytes; }, emit: async event => {
        if (event.type === "file_download") final = Buffer.from(String(event.base64), "base64");
      } },
  });
  assert.ok(snapshot); assert.ok(final);
  const summary = await normalizeEligibilityServiceWorkbook(snapshot, refs, { portal: "uhc", unfinishedAsPending: true });
  assert.equal(summary.counts.failed, 3);
  assert.ok(summary.row_results.every(row => row.error_message?.includes("Unsupported UHC eligibility payer")));
  assert.deepEqual(await normalizeEligibilityServiceWorkbook(final, refs, { portal: "uhc", unfinishedAsPending: true }), summary);
});

test("UHC results retain native columns, treat validation errors as failure, and leave cancelled rows for recovery", async () => {
  const book = new ExcelJS.Workbook(); const sheet = book.addWorksheet("Input");
  sheet.addRow(["Client Row Ref", ...UHC_OUTPUT_HEADERS]);
  const values = (ref: string, coverage: string, error = "") => [ref, ...UHC_OUTPUT_HEADERS.map(header => header === "Coverage Status" ? coverage
    : header === "Error" ? error : header === "Network" ? "INN" : "")];
  sheet.addRow(values("A", "Active"));
  sheet.addRow(values("B", "Active", "UHC eligibility result did not pass portal validation."));
  sheet.addRow(values("C", "", "Cancelled - not processed"));
  const bytes = new Uint8Array(await book.xlsx.writeBuffer());
  const summary = await normalizeEligibilityServiceWorkbook(bytes, refs,
    { portal: "uhc", unfinishedAsPending: true });
  assert.deepEqual(summary.row_results.map(row => row.status), ["SUCCESS", "FAILED", "INCOMPLETE"]);
  assert.equal((summary.row_results[0].result.details as Record<string, string>).Network, "INN");
  const db = publicationDatabase(refs);
  db.setJobState({ workflow_id: "eligibility-verification", status: "cancelling", metadata: { serviceClaimRefs: refs, expectedRowCount: 3 } });
  await publishServiceResultPage({ jobId: "job", expectedRefs: refs, summary, cursor: 0, limit: 1,
    workerState: { artifact: null, finalized: false } }, db.pool);
  const original = db.stored();
  type Job = Parameters<typeof finalizeStoppedServiceJob>[0];
  const current = () => ({ jobId: "job", workflowId: "eligibility-verification", portalId: "uhc", clientSystem: "AR_WORKFLOW",
    status: db.jobState().status, ecsTaskArn: "task", currentCompleted: db.progress()?.completed, totalRows: 3, metadata: db.jobState().metadata } as Job);
  const deps: NonNullable<Parameters<typeof finalizeStoppedServiceJob>[2]> = {
    find: async () => current(), refs: async () => refs,
    snapshot: async () => { throw new Error("Do not read Claim Status snapshots."); }, artifacts: async () => [],
    discover: async () => [{ bucket: "out", object_key: "uhc.xlsx", filename: "uhc-wellmed-eligibility-partial-results.xlsx",
      artifact_type: "output_snapshot", size_bytes: bytes.length, etag: null }], workbook: async () => bytes,
    publish: async () => { throw new Error("Do not use Claim Status publication."); },
    publishEligibility: input => publishServiceResultPage(input, db.pool), notify: async () => 1, notifyStopped: async () => 1,
  };
  await finalizeStoppedServiceJob(current(), { taskArn: "task", lastStatus: "STOPPED", containers: [{ name: "worker", exitCode: 137 }] }, deps);
  assert.deepEqual(db.stored().slice(0, 2), original);
  const last = await readWorkerServiceResultPage("job", 2, 1, db.pool);
  assert.deepEqual([last.results[0].client_row_ref, last.results[0].error_category, last.pending, last.nextCursor], ["C", "CANCELLED", 0, 3]);
});

test("a failed periodic publication retries without turning unprocessed claims into failures", async () => {
  let writes = 0; let warnings = 0;
  const results = new Map([[2, result(2)]]);
  const publish = createEligibilityServiceSnapshots({ jobId: "job", workflowId: "eligibility-verification", portalId: "iehp",
    emit: async () => {}, log: async () => { warnings++; }, saveServiceResults: async () => { if (++writes === 1) throw new Error("DB unavailable"); },
  }, { inputFile: new File([], "input.xlsx"), rows: new Map(), results, errors: new Map() }, async () => new Uint8Array([1]));
  await publish(); await publish();
  assert.deepEqual([writes, warnings, results.size], [2, 1, 1]);
});
