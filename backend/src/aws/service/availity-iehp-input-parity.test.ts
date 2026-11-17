import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as XLSX from "xlsx";
import { getServicePortal, servicePortals, type PreparedServiceInput } from "./portal-dispatch";
import { parseAvailityInput, isRunnableAvailityPayerName } from "../../workflows/claim-status/portals/availity/input";
import { getProviderOrderForRow, getRequiredFieldsForProject, getSelectionRuleProviderOrder } from "../../workflows/claim-status/portals/availity/project-config";
import { getIehpClaimSearchFields, parseIehpClaimStatusInput } from "../../workflows/claim-status/portals/iehp/input";
import { parseDateInput, formatMmDdYyyy } from "../../workflows/claim-status/portals/iehp/claims/dates";
import { reserveServiceSubmission, type ExistingServiceJob } from "./service-submission";
import { authenticateServiceWithToken, ServiceAuthError } from "../runtime/service-auth";
import { submitServiceJob } from "../http/service-jobs";

const require = createRequire(import.meta.url);
const { validateRow } = require("../../workflows/claim-status/portals/availity/services/row-validator.js");
type Row = Record<string, string | number | boolean | null>;
const credentials = { login_url: " example.test/login ", username: " test-user ", password: " dummy-password ", totp_secret: " DUMMYBASE32 " };
const base: Row = { "Payer Name": " Aetna ", "Patient Name": " Jane Doe ", "Patient DOB": "01/02/1990", "Subscriber No": "00123", "Service Date": "10/01/2026", Charges: 100.25 };

// Build manual fixtures independently, using the spreadsheet reader used by
// IEHP's frontend. Never treat the service-generated workbook as manual input.
function manualFile(rows: Row[], name = "manual.xlsx"): File {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Input");
  return new File([new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))], name);
}

function serviceForm(input: PreparedServiceInput): FormData {
  const form = new FormData();
  for (const file of input.files) form.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
  for (const [key, value] of Object.entries(input.formFields)) form.set(key, value);
  form.set("claimRows", input.claimRowsJson);
  return form;
}

function withoutRef(row: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "Client Row Ref"));
}

async function availityPair(rows: Row[], projectId = "minimax", selectionRules?: Row[]) {
  const prepared = await getServicePortal("availity")!.adapter.prepare({
    credentials, projectId, claims: rows.map((data, index) => ({ client_row_ref: `ref-${index}`, data })),
    ...(selectionRules ? { selection_rules: selectionRules } : {}),
  });
  const manual = new FormData();
  manual.set("projectId", projectId);
  manual.set("inputExcel", manualFile(rows));
  manual.set("credentialExcel", manualFile([{ Project: projectId, Link: credentials.login_url, Username: credentials.username, Password: credentials.password, "Secret Key": credentials.totp_secret }]));
  if (selectionRules) manual.set("selectionRulesFile", manualFile(selectionRules));
  const serviceInput = serviceForm(prepared);
  const [manualParsed, serviceParsed] = await Promise.all([parseAvailityInput(manual), parseAvailityInput(serviceInput)]);
  assert.deepEqual(serviceParsed.credentials, manualParsed.credentials);
  assert.deepEqual(serviceParsed.selectionRules, manualParsed.selectionRules);
  assert.deepEqual(serviceParsed.inputRows.map(row => ({ ...row, data: withoutRef(row.data) })), manualParsed.inputRows);
  assert.deepEqual(serviceParsed.inputHeaders.filter(key => key !== "Client Row Ref"), manualParsed.inputHeaders);
  assert.equal(prepared.claimCount, rows.length);
  assert.deepEqual(serviceParsed.inputRows.map(row => row.data["Client Row Ref"]).sort(), rows.map((_, i) => `ref-${i}`).sort());
  return { manual: manualParsed, service: serviceParsed };
}

for (const projectId of ["minimax", "medrevenu", "charm"]) {
  test(`Availity ${projectId}: valid/invalid/valid rows share normalization and row validation`, async () => {
    const valid: Row = { ...base, Group: "Open Mind", "Portal Payer Name": "Aetna", "Portal State": "CA", "Provider NPI": "1234567890" };
    // Use the native project aliases as external input.
    if (projectId === "medrevenu") {
      delete valid["Payer Name"]; valid["Responsible Payer"] = " Aetna ";
      delete valid.Charges; valid["Billed Amount"] = "$1,000.25";
    }
    const invalid: Row = { ...valid, "Service Date": "invalid-date" };
    const { manual, service } = await availityPair([valid, invalid, valid], projectId);
    const validate = (input: typeof manual) => input.inputRows.map(row => validateRow(row, new Map([["aetna", "Aetna"]]), { requiredFields: getRequiredFieldsForProject(projectId) }));
    assert.deepEqual(validate(service), validate(manual));
    assert.deepEqual(validate(service).map(row => row.isValid), [true, false, true]);
    assert.match(validate(service)[1].validation_message, /Invalid Service Date/);
    if (projectId === "medrevenu") assert.equal(service.inputRows[0].data.Charges, "$1,000.25");
    assert.equal(service.credentials.loginUrl, "https://example.test/login");
  });
}

test("Availity: missing required fields and unknown payers remain rows, including all-invalid jobs", async () => {
  const { service } = await availityPair([{ "Payer Name": "Aetna" }, { "Payer Name": "Unknown payer", "Claim No": "C2" }]);
  assert.equal(validateRow(service.inputRows[0], new Map([["aetna", "Aetna"]])).isValid, false);
  assert.equal(isRunnableAvailityPayerName(service.inputRows[1].data["Payer Name"]), false);
  assert.equal(service.inputRows.length, 2);
});

test("Availity Medrevenu: missing Group reaches the same row-level provider error", async () => {
  const { manual, service } = await availityPair([{ ...base, "Provider NPI": "1234567890" }], "medrevenu");
  for (const parsed of [manual, service]) assert.throws(() => getProviderOrderForRow("medrevenu", parsed.inputRows[0], []), /require Group/);
});

test("Availity Charm: aliases, date conversion, patient IDs, defaults and sorting run once in the shared parser", async () => {
  const row: Row = { "Master Payer Name": "Aetna", "Payer to choose in Availity": "Aetna", "State to choose in Availity": "TX", Practice: "Open Mind", "Patient Name": "Jane Doe [P1]", "Date Of Birth": "1/2/1990", "Insured's ID": "00123", "Date Of Service": "Oct 1, 2026", "Claim Amount": "$100.25", "Provider NPI": "1234567890" };
  const { service } = await availityPair([row, { ...row, "State to choose in Availity": "CA" }], "charm");
  assert.deepEqual(service.inputRows.map(row => row.data["Portal State"]), ["CA", "TX"]);
  assert.deepEqual(service.inputRows.map(row => row.data["Client Row Ref"]), ["ref-1", "ref-0"]);
  assert.equal(service.inputRows[0].data["Service Date"], "10/01/2026");
  assert.equal(service.inputRows[0].data["Patient DOB"], "01/02/1990");
  assert.equal(service.inputRows[0].data["Patient Name"], "Jane Doe");
  assert.equal(service.inputRows[0].data["Patient ID"], "P1");
});

test("Availity Charm: selection rules can select providers without row NPI or tax ID", async () => {
  const row = { ...base, Practice: "Open Mind", "Portal Payer Name": "Aetna", "Portal State": "CA" };
  const rules = [{ Practice: "Open Mind", "Provider Mode": "none" }];
  const { manual, service } = await availityPair([row], "charm", rules);
  for (const parsed of [manual, service]) {
    assert.deepEqual(getSelectionRuleProviderOrder("charm", parsed.inputRows[0], "Aetna", parsed.credentials.username, parsed.selectionRules), ["Direct provider identifiers"]);
  }
  const noRules = await availityPair([row], "charm");
  for (const parsed of [noRules.manual, noRules.service]) assert.throws(() => getProviderOrderForRow("charm", parsed.inputRows[0], []), /require Provider NPI or Provider Tax ID/);
});

test("Availity: invalid selection configuration is fatal in the shared parser for either transport", async () => {
  const selection_rules = [{ Practice: "Open Mind", "Provider Mode": "invalid-mode" }];
  const prepared = await getServicePortal("availity")!.adapter.prepare({ credentials, projectId: "charm", claims: [{ client_row_ref: "ref-0", data: base }], selection_rules });
  const manual = new FormData();
  manual.set("projectId", "charm");
  manual.set("selectionRulesFile", manualFile(selection_rules));
  for (const form of [manual, serviceForm(prepared)]) await assert.rejects(parseAvailityInput(form), /Unsupported Charm provider mode/);
});

async function iehpPair(rows: Row[]) {
  const prepared = await getServicePortal("iehp")!.adapter.prepare({
    credentials: { ...credentials, claim_status_url: " example.test/custom-claims " },
    claims: rows.map((data, index) => ({ client_row_ref: `ref-${index}`, data })),
  });
  const manual = new FormData();
  manual.set("claimExcel", manualFile(rows));
  manual.set("loginExcel", manualFile([{ URL: credentials.login_url, "User Name": credentials.username, Password: credentials.password, "Claim Status URL": " example.test/custom-claims " }]));
  manual.set("claimRows", JSON.stringify([{ "Member ID": "stale" }]));
  const [manualParsed, serviceParsed] = await Promise.all([parseIehpClaimStatusInput(manual), parseIehpClaimStatusInput(serviceForm(prepared))]);
  assert.deepEqual({ ...serviceParsed, claimRows: serviceParsed.claimRows.map(withoutRef) }, manualParsed);
  assert.equal(prepared.claimCount, rows.length);
  assert.deepEqual(serviceParsed.claimRows.map(row => row["Client Row Ref"]), rows.map((_, i) => `ref-${i}`));
  return serviceParsed;
}

test("IEHP: valid/missing/valid batch reaches the same worker rows, credentials and indexes", async () => {
  const valid: Row = { "Member ID": " 00123 ", DOS: "2026-10-01", "CPT Code": "99214", Modifier: "25" };
  const parsed = await iehpPair([valid, { "Claim No": "missing-search-fields" }, valid]);
  assert.deepEqual(parsed.claimRows.map(getIehpClaimSearchFields).map(row => Boolean(row.memberPolicyId && row.dosValue)), [true, false, true]);
  assert.deepEqual(parsed.claimRows.map(row => row.__original_index), [0, 1, 2]);
  assert.equal(parsed.claimRows[0]["CPT Code"], "99214");
  assert.equal(parsed.claimRows[0].Modifier, "25");
});

test("IEHP: missing member, missing DOS and invalid DOS do not reject even an all-invalid batch", async () => {
  const rows: Row[] = [{ "Claim No": "C1", DOS: "10/01/2026" }, { "Claim No": "C2", "Member ID": "00123" }, { "Member Policy ID": "00123", "Date Of Service": "invalid" }];
  assert.equal((await iehpPair(rows)).claimRows.length, 3);
});

test("IEHP: a mixed-alias batch never inserts empty canonical cells that shadow valid aliases", async () => {
  const parsed = await iehpPair([
    { "Member Policy ID": "00123", "Date Of Service": "10/01/2026" },
    { "Member ID": "00456", DOS: "10/02/2026" },
  ]);
  assert.deepEqual(parsed.claimRows.map(getIehpClaimSearchFields), [
    { memberPolicyId: "00123", dosValue: "10/01/2026" },
    { memberPolicyId: "00456", dosValue: "10/02/2026" },
  ]);
});

test("IEHP: Excel serial dates, aliases, leading zero IDs and optional scalar values survive both transports", async () => {
  const parsed = await iehpPair([{ "member policy id": "00123", dos: 45931, Amount: 0, Optional: false, Empty: null }]);
  const fields = getIehpClaimSearchFields(parsed.claimRows[0]);
  assert.equal(fields.memberPolicyId, "00123");
  assert.equal(formatMmDdYyyy(parseDateInput(fields.dosValue)!), "10/01/2025");
  assert.equal(parsed.claimRows[0].Amount, 0);
  assert.equal(parsed.claimRows[0].Optional, false);
});

for (const portal of ["availity", "iehp"]) {
  test(`${portal}: mixed invalid claims reserve a job and an identical retry reuses it`, async () => {
    let saved: ExistingServiceJob | null = null;
    let prepares = 0;
    let creates = 0;
    const body = { portal, credentials, claims: [{ client_row_ref: "R1", data: portal === "availity" ? base : { "Member ID": "M1", DOS: "10/01/2026" } }, { client_row_ref: "R2", data: { "Claim No": "invalid" } }] };
    const submit = () => reserveServiceSubmission({
      clientSystem: "AR_WORKFLOW", clientExecutionId: "E1", idempotencyKey: "K1", portalId: portal, body,
      authenticatedToken: "dummy-service-token-at-least-32-characters", find: async () => saved,
      prepare: async () => { prepares++; return getServicePortal(portal)!.adapter.prepare(body); },
      createJobId: () => "job-1", isUniqueViolation: () => false,
      create: async (jobId, prepared, fingerprint, salt) => {
        creates++; assert.equal(prepared.claimCount, 2);
        saved = { jobId, status: "preparing", clientExecutionId: "E1", portalId: portal, metadata: { requestHash: fingerprint, requestHashVersion: 3, requestHashSalt: salt } };
      },
    });
    assert.equal((await submit()).existing, false);
    assert.equal((await submit()).existing, true);
    assert.deepEqual({ prepares, creates }, { prepares: 1, creates: 1 });
    for (const claims of [[], [{ client_row_ref: "duplicate", data: {} }, { client_row_ref: "duplicate", data: {} }], [{ client_row_ref: "R1", data: { invalid: [] } }]]) {
      await assert.rejects(getServicePortal(portal)!.adapter.prepare({ ...body, claims }));
    }
  });
}

test("service authentication still gates submission before any portal preparation", async () => {
  const previous = process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON;
  const token = "dummy-service-token-at-least-32-characters";
  try {
    process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON = JSON.stringify({ AR_WORKFLOW: token });
    assert.deepEqual(authenticateServiceWithToken({ headers: { "X-Client-System": "ar_workflow", Authorization: `Bearer ${token}` } }), { clientSystem: "AR_WORKFLOW", token });
    assert.throws(() => authenticateServiceWithToken({ headers: { "X-Client-System": "AR_WORKFLOW", Authorization: "Bearer invalid" } }), ServiceAuthError);
    for (const portal of Object.keys(servicePortals)) {
      const response = await submitServiceJob({ headers: { "X-Client-System": "AR_WORKFLOW", Authorization: "Bearer invalid" }, body: JSON.stringify({ portal }) });
      assert.equal(response.statusCode, 401);
    }
  } finally {
    if (previous === undefined) delete process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON;
    else process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON = previous;
  }
});
