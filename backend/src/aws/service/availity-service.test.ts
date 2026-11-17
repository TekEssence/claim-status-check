import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { generateAvailityServiceInput, validateAvailityServiceInput } from "./availity-input";
import { normalizeAvailityServiceWorkbook } from "./availity-results";
import { pageServiceResults } from "./iehp-results";
import { publishedResults } from "./result-publication-test-helpers";
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

test("Availity service preparation retains all 10000 claim rows", { timeout: 120_000 }, async () => {
  const portal = getServicePortal("availity");
  assert.ok(portal);
  const claims = Array.from({ length: 10000 }, (_, index) => ({
    client_row_ref: `ar-${index + 1}`,
    data: { ...request.claims[0].data, "Subscriber No": `M${index + 1}` },
  }));
  const prepared = await portal.adapter.prepare({ ...request, claims });
  assert.equal(prepared.claimCount, 10000);
  const refs = JSON.parse(prepared.claimRowsJson) as Array<{ "Client Row Ref": string }>;
  assert.equal(refs.length, 10000);
  assert.equal(refs.at(-1)?.["Client Row Ref"], "ar-10000");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(prepared.files[0].buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  assert.equal(workbook.worksheets[0].rowCount, 10001);
  assert.equal(workbook.worksheets[0].getCell("A10001").value, "ar-10000");
});

test("Availity result normalization keeps all 10000 submitted claims", { timeout: 120_000 }, async () => {
  const refs = Array.from({ length: 10000 }, (_, index) => `ar-${index + 1}`);
  const rows: Array<[string, string, string, string]> = refs.map((ref) => [ref, "success", "Paid", ""]);
  const summary = await normalizeAvailityServiceWorkbook(await makeOutput(rows), refs);
  assert.equal(summary.row_results.length, 10000);
  assert.equal(summary.finalized_count, 10000);
  assert.equal(summary.row_results.at(-1)?.client_row_ref, "ar-10000");
  assert.equal(pageServiceResults(publishedResults(summary), 9999, 100).nextCursor, 10000);
});

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

test("Availity service validation leaves claim business rules to the worker and enforces the service contract", () => {
  assert.equal(validateAvailityServiceInput({ ...request, claims: [{ client_row_ref: "x", data: { "Payer Name": "Aetna" } }] }).claims.length, 1);
  assert.throws(() => validateAvailityServiceInput({ ...request, credentials: { ...request.credentials, totp_secret: "" } }), /totp_secret/);
  assert.throws(() => validateAvailityServiceInput({ ...request, claims: [request.claims[0], { ...request.claims[0] }] }), /Duplicate client_row_ref/);
});

test("Charm custom selection rules reach the same parser as manual rule uploads", async () => {
  const selectionRules = [{ Practice: "Open Mind", "Organization to select": "Test organization", "Provider Mode": "groupNameOnly", "Tab to use": "HIPAA Standard" }];
  const prepared = await getServicePortal("availity")!.adapter.prepare({
    ...request, projectId: "charm", selection_rules: selectionRules,
    claims: [{ client_row_ref: "ar-1", data: { ...request.claims[0].data, Practice: "Open Mind", "Provider NPI": "1234567890", "Portal Payer Name": "Aetna", "Portal State": "CA" } }],
  });
  const serviceForm = new FormData();
  serviceForm.set("projectId", "charm");
  for (const file of prepared.files) serviceForm.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
  const serviceParsed = await parseAvailityInput(serviceForm);
  const manualForm = new FormData();
  for (const [key, value] of serviceForm.entries()) if (key !== "selectionRulesFile") manualForm.set(key, value);
  const manualBook = new ExcelJS.Workbook();
  const sheet = manualBook.addWorksheet("Manual rules");
  sheet.addRow(["Practice", "Organization to select", "Provider Mode", "Tab to use"]);
  sheet.addRow(["Open Mind", "Test organization", "groupNameOnly", "HIPAA Standard"]);
  manualForm.set("selectionRulesFile", new File([new Uint8Array(await manualBook.xlsx.writeBuffer())], "manual-rules.xlsx"));
  assert.deepEqual(serviceParsed.selectionRules, (await parseAvailityInput(manualForm)).selectionRules);
  assert.equal(serviceParsed.selectionRules![0].use.organization, "Test organization");
  const unsupported = await getServicePortal("availity")!.adapter.prepare({ ...request, selection_rules: selectionRules });
  const unsupportedForm = new FormData();
  for (const file of unsupported.files) unsupportedForm.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
  await assert.rejects(parseAvailityInput(unsupportedForm), /only for Charm/);
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
  const normalizedInput = validateAvailityServiceInput({ ...charm, projectId: "  CHARM   HEALTH  " });
  assert.equal(normalizedInput.projectId, "charm");
  const generated = await generateAvailityServiceInput(normalizedInput);
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
  const first = pageServiceResults(publishedResults(summary), 0, 1);
  const repeated = pageServiceResults(publishedResults(await normalizeAvailityServiceWorkbook(bytes, refs)), 0, 1);
  assert.deepEqual(first, repeated);
  assert.equal(first.nextCursor, 1);
  assert.deepEqual(pageServiceResults(publishedResults(summary), 1, 1).results.map((row) => row.client_row_ref), ["ar-102"]);
});

test("Availity partial output finalizes later claims despite an earlier unfinished claim", async () => {
  const bytes = await makeOutput([["ar-102", "success", "Second claim done", ""]]);
  const summary = await normalizeAvailityServiceWorkbook(bytes, ["ar-101", "ar-102"]);
  assert.deepEqual(summary.row_results.map((row) => row.status), ["INCOMPLETE", "SUCCESS"]);
  assert.equal(summary.finalized_count, 1);
  assert.deepEqual(pageServiceResults(publishedResults(summary), 0, 100).results.map(row => row.client_row_ref), ["ar-102"]);
  assert.equal(pageServiceResults(publishedResults(summary), 0, 100).nextCursor, 1);
});

test("Availity output rejects unexpected claim references", async () => {
  await assert.rejects(normalizeAvailityServiceWorkbook(await makeOutput([["unknown", "success", "Paid", ""]]), ["ar-101"]), /unexpected Client Row Ref/);
});
