import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { getAutomationRunner } from "../../workflows/registry";
import { readMemberSearchRows } from "../../workflows/eligibility-verification/portals/availity/medrevenue/data";
import { readAvailityEligibilityCredentialProfiles } from "../../workflows/eligibility-verification/portals/availity/credentials";
import { buildWaystarOutputWorkbook } from "../../workflows/eligibility-verification/portals/waystar/output";
import { normalizeEligibilityServiceWorkbook } from "./eligibility-results";
import { pageServiceResults } from "./iehp-results";
import { serviceSubmissionFingerprint } from "./service-submission";
import { getServiceWorkflow, getServiceWorkflowForJob, resolveServiceWorkflowRoute, SERVICE_WORKFLOW_IDS, ServiceWorkflowDispatchError, supportedServiceWorkflowIds } from "./workflow-registry";

const eligibility = {
  projectId: "medrevenue",
  credentials: { login_url: "https://example.test/login", username: "test@example.test", password: "dummy-password", totp_secret: "DUMMYBASE32SECRET" },
  claims: [
    { client_row_ref: "ar-1", data: { "Primary Insurance Name": "Molina", "Patient Name": "Jane Example", "Member ID": "M001", DOB: "01/02/1990", DOS: "10/20/2026" } },
    { client_row_ref: "ar-2", data: { "Primary Insurance Name": "Molina", "Patient Name": "John Example", "Member ID": "M002", DOB: "02/03/1991", DOS: "10/21/2026" } },
  ],
};

test("one registry retains the existing Claim Status service dispatch and names runner workflows", () => {
  const claimStatus = getServiceWorkflow(SERVICE_WORKFLOW_IDS.CLAIM_STATUS)!;
  assert.equal(claimStatus.runnerWorkflowId, "claim-status");
  assert.deepEqual(Object.keys(claimStatus.portals).sort(), ["availity", "iehp"]);
  assert.equal(getServiceWorkflowForJob("claim-status"), claimStatus);
  assert.equal(getServiceWorkflow(SERVICE_WORKFLOW_IDS.ELIGIBILITY)?.runnerWorkflowId, "eligibility-verification");
  assert.equal(getServiceWorkflow(SERVICE_WORKFLOW_IDS.EOB_DOWNLOAD)?.runnerWorkflowId, "payment-eob-download");
  assert.match(getServiceWorkflow(SERVICE_WORKFLOW_IDS.EOB_DOWNLOAD)?.unavailableReason ?? "", /date range or reference\/control-log batch/);
  assert.deepEqual(supportedServiceWorkflowIds(), [SERVICE_WORKFLOW_IDS.CLAIM_STATUS, SERVICE_WORKFLOW_IDS.ELIGIBILITY]);
  assert.equal(getServiceWorkflow("eligibility-verification"), null);
  assert.equal(getServiceWorkflow(SERVICE_WORKFLOW_IDS.ELIGIBILITY)?.portals.iehp, undefined);
});

test("unsupported workflow, unsupported portal and EOB batch mismatch are explicit", () => {
  assert.throws(() => resolveServiceWorkflowRoute("UNKNOWN", "availity"),
    (error: unknown) => error instanceof ServiceWorkflowDispatchError && error.statusCode === 400 && /UNKNOWN.*CLAIM_STATUS, ELIGIBILITY/.test(error.message));
  assert.throws(() => resolveServiceWorkflowRoute(SERVICE_WORKFLOW_IDS.ELIGIBILITY, "iehp"),
    (error: unknown) => error instanceof ServiceWorkflowDispatchError && error.statusCode === 422 && /ELIGIBILITY.*availity/.test(error.message));
  assert.throws(() => resolveServiceWorkflowRoute(SERVICE_WORKFLOW_IDS.EOB_DOWNLOAD, "zelis"),
    (error: unknown) => error instanceof ServiceWorkflowDispatchError && error.statusCode === 422 && /date range or reference\/control-log batch/.test(error.message));
});

test("structured Eligibility rows become valid existing Availity MedRevenue runner input", async () => {
  const adapter = getServiceWorkflow(SERVICE_WORKFLOW_IDS.ELIGIBILITY)!.portals.availity;
  const prepared = await adapter.prepare(eligibility);
  assert.deepEqual(prepared.files.map((file) => file.field), ["inputFile", "credentialFile"]);
  assert.deepEqual(JSON.parse(prepared.claimRowsJson).map((row: Record<string, string>) => row["Client Row Ref"]), ["ar-1", "ar-2"]);
  assert.equal(prepared.claimRowsJson.includes("dummy-password"), false);
  assert.equal(prepared.accountLabel.includes("test@example.test"), false);
  const form = new FormData();
  form.set("projectId", prepared.formFields.projectId);
  form.set("inputFile", new File([Uint8Array.from(prepared.files[0].buffer)], prepared.files[0].filename));
  form.set("credentialFile", new File([Uint8Array.from(prepared.files[1].buffer)], prepared.files[1].filename));
  const runner = getAutomationRunner("eligibility-verification", "availity");
  const input = runner.validateInput(form) as { inputFile: File; credentialFile: File; projectId: "medrevenue" };
  const rows = await readMemberSearchRows(input.inputFile, {
    id: "medrevenue", inquiryMode: "member-search", payers: { molina: { portalPayerName: "MOLINA HEALTHCARE CALIFORNIA", insuranceNameAliases: ["Molina"] } },
  } as Parameters<typeof readMemberSearchRows>[1]);
  assert.deepEqual(rows.map((row) => row.raw["Client Row Ref"]), ["ar-1", "ar-2"]);
  const credentials = await readAvailityEligibilityCredentialProfiles(input.credentialFile, input.projectId);
  assert.equal(credentials[0].username, eligibility.credentials.username);
});

test("Eligibility results retain submission order, row references and cursor granularity", async () => {
  const workbook = new ExcelJS.Workbook();
  const output = workbook.addWorksheet("Output");
  output.addRow(["Client Row Ref", "Coverage Status", "Eff Date", "End Date"]);
  output.addRow(["ar-2", "error", "-", "-"]);
  output.addRow(["ar-1", "active", "01/01/2026", "12/31/2026"]);
  const errors = workbook.addWorksheet("Error Log");
  errors.addRow(["Timestamp", "Row", "Error"]);
  errors.addRow(["2026-10-27T00:00:00Z", 2, "No member result matches the input member identity."]);
  const summary = await normalizeEligibilityServiceWorkbook(
    new Uint8Array(await workbook.xlsx.writeBuffer()), ["ar-1", "ar-2"]);
  assert.deepEqual(summary.row_results.map((row) => [row.client_row_ref, row.status]), [["ar-1", "SUCCESS"], ["ar-2", "NO_MATCH"]]);
  assert.equal(summary.row_results[0].result.coverage_status, "active");
  assert.equal(summary.finalized_count, 2);
  assert.equal(summary.outcome, "PARTIAL_SUCCESS");
  assert.deepEqual(pageServiceResults(summary, 0, 1, false).results.map((row) => row.client_row_ref), ["ar-1"]);
  assert.deepEqual(pageServiceResults(summary, 0, 1, false), pageServiceResults(summary, 0, 1, false));
  assert.equal(pageServiceResults(summary, 0, 1, false).nextCursor, 1);
});

test("the existing Eligibility output writer keeps service row references for normalization", async () => {
  const prepared = await getServiceWorkflow(SERVICE_WORKFLOW_IDS.ELIGIBILITY)!.portals.availity.prepare(eligibility);
  const inputFile = new File([Uint8Array.from(prepared.files[0].buffer)], prepared.files[0].filename);
  const output = await buildWaystarOutputWorkbook({
    inputFile, projectId: "medrevenue",
    rows: new Map(),
    results: new Map([[2, { rowIndex: 2, payerId: "molina", coverageStatus: "active", planStatus: "Active", benefits: [] }]]),
    errors: new Map([[3, "No member result matches the input member identity."]]),
  });
  const summary = await normalizeEligibilityServiceWorkbook(new Uint8Array(output), ["ar-1", "ar-2"]);
  assert.deepEqual(summary.row_results.map((row) => [row.client_row_ref, row.status]), [["ar-1", "SUCCESS"], ["ar-2", "NO_MATCH"]]);
});

test("Eligibility rejects unsupported project, payer and incomplete members before launch", async () => {
  const adapter = getServiceWorkflow(SERVICE_WORKFLOW_IDS.ELIGIBILITY)!.portals.availity;
  await assert.rejects(adapter.prepare({ ...eligibility, projectId: "minimax" }), /projectId/);
  await assert.rejects(adapter.prepare({ ...eligibility, claims: [{ ...eligibility.claims[0], data: { ...eligibility.claims[0].data, "Primary Insurance Name": "Unmapped Payer" } }] }), /unsupported Primary Insurance Name/);
  await assert.rejects(adapter.prepare({ ...eligibility, claims: [{ ...eligibility.claims[0], data: { ...eligibility.claims[0].data, "Member ID": "" } }] }), /missing Member ID/);
  await assert.rejects(adapter.prepare({ ...eligibility, claims: [{ ...eligibility.claims[0], data: { ...eligibility.claims[0].data, DOB: "2026-02-30" } }] }), /DOB must be a valid/);
});

test("the shared idempotency fingerprint includes the canonical workflow", () => {
  const salt = Buffer.alloc(16, 7).toString("base64url");
  const envelope = { client_system: "AR_WORKFLOW", idempotency_key: "key-1", portal: "availity", claims: eligibility.claims };
  const claim = serviceSubmissionFingerprint({ ...envelope, workflow: SERVICE_WORKFLOW_IDS.CLAIM_STATUS }, salt);
  const other = serviceSubmissionFingerprint({ ...envelope, workflow: SERVICE_WORKFLOW_IDS.ELIGIBILITY }, salt);
  assert.notEqual(claim, other);
});
