import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { generateAvailityServiceInput, validateAvailityServiceInput } from "./availity-input";
import { normalizeAvailityServiceWorkbook } from "./availity-results";
import { pageServiceResults } from "./iehp-results";
import { getServicePortal } from "./portal-dispatch";
import { parseAvailityInput } from "../../workflows/claim-status/portals/availity/input";
import { createAvailityOutputWorkbookBuffer } from "../../workflows/claim-status/portals/availity/output-writer";

const request = {
  projectId: "minimax",
  credentials: {
    login_url: "https://example.test/login",
    username: "user@example.test",
    password: "dummy-password",
    totp_secret: "DUMMYBASE32SECRET",
  },
  claims: [
    { client_row_ref: "ar-101", data: { "Payer Name": "Aetna", "Patient Name": "Test One", "Patient DOB": "01/01/2000", "Subscriber No": "M101", "Service Date": "10/01/2026", Charges: "100" } },
    { client_row_ref: "ar-102", data: { "Payer Name": "Aetna", "Patient Name": "Test Two", "Patient DOB": "02/02/2000", "Subscriber No": "M102", "Service Date": "10/02/2026", Charges: "200" } },
  ],
};

function makeOutput(rows: Array<[string, string, string, string]>) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Output");
  sheet.addRow(["input_row_id", "Client Row Ref", "bot_overall_result", "bot_updated_claim_status", "bot_notes"]);
  rows.forEach(([ref, status, details, notes], index) => sheet.addRow([index + 1, ref, status, details, notes]));
  return workbook.xlsx.writeBuffer().then((buffer) => new Uint8Array(buffer));
}

test("Availity service dispatch generates the existing claim and credential workbook inputs", async () => {
  const portal = getServicePortal("availity");
  assert.ok(portal);
  const prepared = await portal.adapter.prepare(request);
  assert.deepEqual(prepared.files.map((file) => file.field), ["inputExcel", "credentialExcel"]);
  assert.equal(prepared.formFields.projectId, "minimax");
  assert.equal(prepared.accountLabel.includes("user@example.test"), false);
  assert.equal(prepared.claimRowsJson.includes("dummy-password"), false);
  assert.equal(prepared.claimRowsJson.includes("DUMMYBASE32SECRET"), false);

  const formData = new FormData();
  formData.set("projectId", prepared.formFields.projectId);
  formData.set("inputExcel", new File([Uint8Array.from(prepared.files[0].buffer)], prepared.files[0].filename));
  formData.set("credentialExcel", new File([Uint8Array.from(prepared.files[1].buffer)], prepared.files[1].filename));
  const parsed = await parseAvailityInput(formData);
  assert.equal(parsed.inputRows.length, 2);
  assert.deepEqual(parsed.inputRows.map((row) => row.data["Client Row Ref"]), ["ar-101", "ar-102"]);
  assert.equal(parsed.credentials.totpSecret, request.credentials.totp_secret);
  assert.equal(parsed.credentials.password, request.credentials.password);
});

test("Availity service validation enforces project claim fields and TOTP credentials", () => {
  assert.throws(() => validateAvailityServiceInput({ ...request, claims: [{ client_row_ref: "x", data: { "Payer Name": "Aetna" } }] }), /missing/);
  assert.throws(() => validateAvailityServiceInput({ ...request, credentials: { ...request.credentials, totp_secret: "" } }), /totp_secret/);
  assert.throws(() => validateAvailityServiceInput({ ...request, claims: [request.claims[0], { ...request.claims[0] }] }), /Duplicate client_row_ref/);
});

test("Charm aliases and project preprocessing retain the submitted references", async () => {
  const charmData = {
    "Master Payer Name": "Aetna",
    "Payer to choose in Availity": "Aetna",
    "State to choose in Availity": "CA",
    Practice: "Open Mind",
    "Patient Name": "Test Patient",
    "Date Of Birth": "01/01/2000",
    "Insured's ID": "M101",
    "Date Of Service": "10/01/2026",
    "Claim Amount": "100",
    "Provider NPI": "1234567890",
  };
  const charm = {
    ...request,
    projectId: "charm",
    claims: [
      { client_row_ref: "ar-charm-1", data: { ...charmData, "State to choose in Availity": "TX" } },
      { client_row_ref: "ar-charm-2", data: charmData },
    ],
  };
  const generated = await generateAvailityServiceInput(validateAvailityServiceInput(charm));
  const formData = new FormData();
  formData.set("projectId", "charm");
  formData.set("inputExcel", new File([Uint8Array.from(generated.claimWorkbook)], "charm.xlsx"));
  formData.set("credentialExcel", new File([Uint8Array.from(generated.credentialWorkbook)], "login.xlsx"));
  const parsed = await parseAvailityInput(formData);
  assert.deepEqual(new Set(parsed.inputRows.map((row) => row.data["Client Row Ref"])), new Set(["ar-charm-1", "ar-charm-2"]));
  assert.deepEqual(parsed.inputRows.map((row) => row.data["Portal State"]), ["CA", "TX"]);
  assert.deepEqual(JSON.parse(generated.claimRowsJson).map((row: Record<string, string>) => row["Client Row Ref"]), ["ar-charm-1", "ar-charm-2"]);
});

test("the existing Availity output writer carries Client Row Ref into normalized results", async () => {
  const generated = await generateAvailityServiceInput(validateAvailityServiceInput(request));
  const formData = new FormData();
  formData.set("projectId", "minimax");
  formData.set("inputExcel", new File([Uint8Array.from(generated.claimWorkbook)], "availity_claims.xlsx"));
  formData.set("credentialExcel", new File([Uint8Array.from(generated.credentialWorkbook)], "availity_credentials.xlsx"));
  const parsed = await parseAvailityInput(formData);
  const outputRows = parsed.inputRows.map((row) => ({
    ...row.data,
    input_row_id: row.input_row_id,
    bot_overall_result: "success",
    bot_updated_claim_status: `Paid ${row.data["Client Row Ref"]}`,
  }));
  const workbook = await createAvailityOutputWorkbookBuffer({
    inputHeaders: parsed.inputHeaders,
    inputRows: [], outputRows, errorRows: [], auditRows: [],
  });
  const summary = await normalizeAvailityServiceWorkbook(new Uint8Array(workbook), ["ar-101", "ar-102"]);
  assert.deepEqual(summary.row_results.map((row) => [row.client_row_ref, row.status]), [["ar-101", "SUCCESS"], ["ar-102", "SUCCESS"]]);
});

test("Availity output preserves submitted claim order and advances once per claim", async () => {
  const bytes = await makeOutput([
    ["ar-102", "No Results", "No claim found", ""],
    ["ar-101", "success", "Paid claim one", ""],
    ["ar-101", "success", "Paid claim detail two", ""],
  ]);
  const refs = ["ar-101", "ar-102"];
  const summary = await normalizeAvailityServiceWorkbook(bytes, refs);
  assert.deepEqual(summary.row_results.map((row) => [row.client_row_ref, row.status]), [["ar-101", "SUCCESS"], ["ar-102", "NO_MATCH"]]);
  assert.equal(summary.row_results[0].result.detail_rows?.length, 2);
  assert.equal(summary.outcome, "PARTIAL_SUCCESS");
  const first = pageServiceResults(summary, 0, 1, false);
  const repeated = pageServiceResults(await normalizeAvailityServiceWorkbook(bytes, refs), 0, 1, false);
  assert.deepEqual(first, repeated);
  assert.equal(first.nextCursor, 1);
  assert.deepEqual(pageServiceResults(summary, 1, 1, false).results.map((row) => row.client_row_ref), ["ar-102"]);
});

test("Availity partial output only exposes a completed prefix", async () => {
  const bytes = await makeOutput([["ar-102", "success", "Second claim done", ""]]);
  const summary = await normalizeAvailityServiceWorkbook(bytes, ["ar-101", "ar-102"]);
  assert.deepEqual(summary.row_results.map((row) => row.status), ["INCOMPLETE", "SUCCESS"]);
  assert.equal(summary.finalized_count, 0);
  assert.deepEqual(pageServiceResults(summary, 0, 100, false).results, []);
  assert.equal(pageServiceResults(summary, 0, 100, true).nextCursor, 2);
});

test("Availity output rejects unexpected claim references", async () => {
  await assert.rejects(normalizeAvailityServiceWorkbook(await makeOutput([["unknown", "success", "Paid", ""]]), ["ar-101"]), /unexpected Client Row Ref/);
});
