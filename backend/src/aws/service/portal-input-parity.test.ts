import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { prepareGenericClaimStatusServiceInput, claimStatusServicePortalConfigs, type GenericClaimStatusServicePortalId } from "./generic-claim-status-input";
import { readPortalClaimRows, asArrayBuffer } from "./portal-input-test-helpers";
import { parseAerialInput } from "../../workflows/claim-status/portals/aerial/input";
import { parseAllCareInput, readAllCareCredentials, readAllCareInputRows, routeAllCareRows } from "../../workflows/claim-status/portals/all-care/input";
import { parseAstronaInput, readAstronaCredentials, readAstronaInputRows, routeAstronaRows } from "../../workflows/claim-status/portals/astrona/input";
import { parseBlueShieldInput, readBlueShieldInputWorkbook, routeBlueShieldRowsByCredentials } from "../../workflows/claim-status/portals/blue-shield/input";
import { parseCignaInput } from "../../workflows/claim-status/portals/cigna/input";
import { parseKaiserInput } from "../../workflows/claim-status/portals/kaiser/input";
import { parseMyFamilyInput } from "../../workflows/claim-status/portals/my_family/input";
import { parsePhysiciansInput } from "../../workflows/claim-status/portals/physicians/input";
import { parseMedpointInput } from "../../workflows/claim-status/portals/medpoint/input";
import { parseOptumProInput } from "../../scrapers/optum-pro/input";
import { parseRegalInput } from "../../workflows/claim-status/portals/regal/input";
import { parseWaystarInput } from "../../workflows/claim-status/portals/waystar/input";
import { readLoginExcel } from "../../workflows/claim-status/portals/uhc/excel";
import { reserveServiceSubmission, type ExistingServiceJob } from "./service-submission";
import { prepareUhcRuntimeClaims } from "../../workflows/claim-status/portals/uhc/runtime-input";
import { CLAIM_CREDENTIAL_SCOPE_COLUMNS, resolveClaimCredentialScopes } from "../../workflows/claim-status/credential-scopes";
import { listClaimStatusPortals } from "../../workflows/claim-status/registry";
import { servicePortals } from "./portal-dispatch";

async function excel(rows: Record<string, unknown>[], verification = false): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Input");
  const headers = [...new Set(rows.flatMap(Object.keys))];
  sheet.addRow(headers);
  rows.forEach(row => sheet.addRow(headers.map(key => row[key] ?? "")));
  if (verification) {
    const checks = book.addWorksheet("Verification");
    checks.addRow(["User Name", "Question", "Answer"]);
    checks.addRow(["test-user", "Favorite food?", "Dummy answer"]);
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

const creds = { username: "test-user", password: "dummy-password" };
const login = { Username: creds.username, Password: creds.password };
type Fixture = { data: Record<string, string>; login: Record<string, string>; credentials?: Record<string, unknown>; fields?: Record<string, string>; keys: string[] };
const fixtures: Record<GenericClaimStatusServicePortalId, Fixture> = {
  aerial: { data: { "Group Name": "Alpha", "Claim Number": "C1", "Member ID": "00123", DOS: "01/02/2026" }, login: { ...login, "Sub portal": "PMG", Group: "Alpha", URL: "https://example.test", "Claims URL": "https://example.test/claims", "Success URL Fragment": "/ready" }, credentials: { login_url: "https://example.test", claims_url: "https://example.test/claims", success_url_fragment: "/ready" }, fields: { aerialSubportal: "PMG" }, keys: ["Group", "Claim No", "Subscriber No", "Service Date", "normalized"] },
  "all-care": { data: { IPA: "Alpha", "Responsible Party": "Aetna", ID: "00123", "Service Date": "01/02/2026", "CPT Code": "99214" }, login: { ...login, Group: "Alpha", Payer: "Aetna", URL: "https://example.test" }, credentials: { login_url: "https://example.test" }, keys: ["group", "payer", "memberId", "dos", "cptCode"] },
  astrona: { data: { "Provider Group": "Alpha", "Payer Name": "Aetna", "Patient Name": "Doe, Jane", DOS: "01/02/2026" }, login: { ...login, Group: "Alpha", Payer: "Aetna", URL: "https://example.test" }, credentials: { login_url: "https://example.test" }, keys: ["group", "payer", "memberId", "memberName", "dos"] },
  "blue-shield": { data: { "Group Name": "AHK", "Subscriber ID": "00123", "Date Of Service": "01/02/2026", "Procedure Code": "99214" }, login: { ...login, Group: "IUMG", URL: "https://example.test", "Claim URL": "https://example.test/custom-claims", Mailbox: "test@example.test" }, credentials: { group: "IUMG", login_url: "https://example.test", claim_status_url: "https://example.test/custom-claims", mfa_mailbox: "test@example.test" }, keys: ["group", "memberId", "dos", "cptCode"] },
  cigna: { data: { "Patient ID": "00123", "Patient Name": "Doe, Jane", "Procedure Code": "99214", "Service Date": "01/02/2026" }, login, keys: ["memberId", "patientFirstName", "patientLastName", "dos", "cptCode"] },
  kaiser: { data: { "Member Policy ID": "00123", "Service Date": "01/02/2026", "Procedure Code": "99214" }, login, keys: ["memberId", "dos", "cptCode"] },
  "my-family": { data: { "Patient Name": "Doe, Jane", "Service Date": "01/02/2026", "Provider Claim ID": "C1" }, login, keys: ["memberId", "patientFirstName", "patientLastName", "dos", "providerClaimId"] },
  physicians: { data: { "Subscriber ID": "00123", "Date of Service From": "01/02/2026", "To DOS": "01/03/2026", "Patient Account #": "A1", "Auth #": "AUTH1" }, login, keys: ["memberId", "dos", "dosTo", "providerClaimId", "authorizationNumber"] },
  medpoint: { data: { "Patient Name": "Doe, Jane", DOS: "01/02/2026", "Claim #": "C1", "Account Number": "A1" }, login, keys: ["memberLastName", "memberFirstName", "serviceFromDate", "serviceToDate", "claimNumber", "patientAccount"] },
  "optum-pro": { data: { "Medical Group Name": "Alpha", "Patient Name": "Doe, Jane", "Service Date": "01/02/2026", "CPT Code": "99214" }, login, keys: ["medicalGroupName", "patient", "dos", "cpt", "memberId"] },
  regal: { data: { Site: "IUMG", "Patient Name": "Doe, Jane", "Service Date": "01/02/2026", "Account No": "A1" }, login: { ...login, Link: "https://example.test" }, credentials: { login_url: "https://example.test" }, keys: ["group", "memberName", "dos", "accountNumber"] },
  uhc: { data: { "Group Name": "BZA", "Member ID": "00123", DOB: "01/01/1990", DOS: "01/02/2026", "CPT Code": "99214" }, login, fields: { clientType: "medrevenu" }, keys: ["group", "subscriberNo", "patientDOB", "serviceDate", "CPT Code"] },
  waystar: { data: { "Member Name": "Doe, Jane", Insurance: "Aetna", "Service Date": "01/02/2026" }, login: { ...login, URL: "https://example.test/waystar", "Provider ID": "P1", "Provider Name": "Test provider", "Service Type Code": "35" }, credentials: { login_url: "https://example.test/waystar", provider_id: "P1", provider_name: "Test provider", service_type_code: "35", verification_answers: [{ question: "Favorite food?", answer: "Dummy answer" }] }, keys: ["patientName", "responsiblePayer", "dos"] },
};

async function credentialsFor(portal: GenericClaimStatusServicePortalId, form: FormData): Promise<unknown> {
  switch (portal) {
    case "aerial": { const parsed = await parseAerialInput(form); return { credentials: parsed.credentials, groups: parsed.credentialGroups }; }
    case "all-care": { const parsed = await parseAllCareInput(form); return routeAllCareRows(readAllCareInputRows(parsed.inputWorkbookBuffer), readAllCareCredentials(parsed.credentialWorkbookBuffer)).batches.map(batch => batch.credentials); }
    case "astrona": { const parsed = await parseAstronaInput(form); return routeAstronaRows(readAstronaInputRows(parsed.inputWorkbookBuffer), readAstronaCredentials(parsed.credentialWorkbookBuffer)).batches.map(batch => batch.credentials); }
    case "blue-shield": { const parsed = await parseBlueShieldInput(form); return { credentials: routeBlueShieldRowsByCredentials(readBlueShieldInputWorkbook(parsed.inputWorkbookBuffer), parsed.credentialWorkbookBuffer).batches.map(batch => batch.credentials), resetCheckpoint: parsed.resetCheckpoint, checkpointId: parsed.checkpointId }; }
    case "cigna": return (await parseCignaInput(form)).credentials;
    case "kaiser": return (await parseKaiserInput(form)).credentials;
    case "my-family": return (await parseMyFamilyInput(form)).credentials;
    case "physicians": return (await parsePhysiciansInput(form)).credentials;
    case "medpoint": return (await parseMedpointInput(form)).credentials;
    case "optum-pro": return (await parseOptumProInput(form)).credentials;
    case "regal": { const parsed = await parseRegalInput(form); assert.equal(parsed.startIndex, 0); return parsed.credentials; }
    case "waystar": return (await parseWaystarInput(form)).credentials;
    case "uhc": return readLoginExcel(await (form.get("loginExcel") as File).arrayBuffer());
  }
}

for (const portal of Object.keys(fixtures) as GenericClaimStatusServicePortalId[]) {
  test(`${portal}: service aliases, optional data, credentials and defaults match an independent manual workbook`, async () => {
    const fixture = fixtures[portal];
    const config = claimStatusServicePortalConfigs[portal];
    const prepared = await prepareGenericClaimStatusServiceInput(portal, { projectId: portal === "aerial" ? "PMG" : "medrevenu", credentials: { ...creds, ...fixture.credentials }, claims: [{ client_row_ref: "claim-1", data: fixture.data }] });
    const service = new FormData();
    for (const file of prepared.files) service.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
    for (const [key, value] of Object.entries(prepared.formFields)) service.set(key, value);
    const manual = new FormData();
    const manualClaims = await excel([fixture.data]);
    manual.set(config.claimField, new File([new Uint8Array(manualClaims)], prepared.claimFileName));
    manual.set(config.loginField, new File([new Uint8Array(await excel([fixture.login], portal === "waystar"))], "manual-login.xlsx"));
    for (const [key, value] of Object.entries(fixture.fields ?? {})) manual.set(key, value);
    assert.deepEqual(await credentialsFor(portal, service), await credentialsFor(portal, manual));
    const projection = (rows: Record<string, unknown>[]) => rows.map(row => Object.fromEntries(fixture.keys.map(key => [key, row[key]])));
    assert.deepEqual(projection(await readPortalClaimRows(portal, prepared.files[0].buffer)), projection(await readPortalClaimRows(portal, manualClaims)));
    assert.equal(prepared.claimCount, 1);
  });
}

test("Aerial validates subportal and group matching with the native credential reader", async () => {
  const request = { projectId: "Citrus Valley", credentials: { ...creds, login_url: "https://example.test" }, claims: [{ client_row_ref: "claim-1", data: { Group: "Alpha", "Member ID": "00123", DOS: "01/02/2026" } }] };
  const prepared = await prepareGenericClaimStatusServiceInput("aerial", request);
  assert.equal(prepared.formFields.aerialSubportal, "citrus-valley");
  const mismatched = await prepareGenericClaimStatusServiceInput("aerial", { ...request, credentials: { ...request.credentials, group: "Other" } });
  const form = new FormData();
  for (const file of mismatched.files) form.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
  for (const [key, value] of Object.entries(mismatched.formFields)) form.set(key, value);
  await assert.rejects(parseAerialInput(form), /No Citrus Valley credentials matched input Group/);
  await assert.rejects(prepareGenericClaimStatusServiceInput("aerial", { ...request, projectId: "unknown" }), /Unsupported Aerial subportal/);
});

test("portals that read only one credential account reject multiple accounts instead of silently choosing the first", async () => {
  await assert.rejects(prepareGenericClaimStatusServiceInput("regal", {
    credentials: { accounts: [creds, creds] }, claims: [{ client_row_ref: "claim-1", data: fixtures.regal.data }],
  }), /one credential account per job/);
});

test("Blue Shield retains its existing mail configuration sheet without applying it inside the API handler", async () => {
  const previous = process.env.PORTAL_BLUE_SHIELD_OTP_SENDER_DOMAINS;
  const prepared = await prepareGenericClaimStatusServiceInput("blue-shield", {
    credentials: { ...creds, ...fixtures["blue-shield"].credentials, mail_configuration: { PORTAL_BLUE_SHIELD_OTP_SENDER_DOMAINS: "dummy.example.test" } },
    claims: [{ client_row_ref: "claim-1", data: fixtures["blue-shield"].data }],
  });
  assert.equal(process.env.PORTAL_BLUE_SHIELD_OTP_SENDER_DOMAINS, previous);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(asArrayBuffer(prepared.files[1].buffer));
  assert.equal(book.getWorksheet("MailConfigurations")!.getRow(1).getCell(2).value, "dummy.example.test");
});

// Compare the complete native rows, including validation messages, normalized
// fields, original indexes and raw data. Only correlation metadata differs.
function stripCorrelation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripCorrelation);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "Client Row Ref" && key !== "__original_index")
    .map(([key, entry]) => [key, stripCorrelation(entry)]));
  return value;
}

function formFor(prepared: Awaited<ReturnType<typeof prepareGenericClaimStatusServiceInput>>) {
  const form = new FormData();
  for (const file of prepared.files) form.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
  for (const [key, value] of Object.entries(prepared.formFields)) form.set(key, value);
  form.set("claimRows", prepared.claimRowsJson);
  return form;
}

async function independentPair(portal: GenericClaimStatusServicePortalId, rows: Record<string, unknown>[], accountOverrides: Record<string, unknown> = {}) {
  const fixture = fixtures[portal];
  const config = claimStatusServicePortalConfigs[portal];
  const prepared = await prepareGenericClaimStatusServiceInput(portal, {
    projectId: portal === "aerial" ? "PMG" : "medrevenu",
    credentials: { ...creds, ...fixture.credentials, ...accountOverrides },
    claims: rows.map((data, index) => ({ client_row_ref: `claim-${index + 1}`, data })),
  });
  const manual = new FormData();
  const manualClaims = await excel(rows);
  manual.set(config.claimField, new File([new Uint8Array(manualClaims)], prepared.claimFileName));
  manual.set(config.loginField, new File([new Uint8Array(await excel([fixture.login], portal === "waystar"))], "manual-login.xlsx"));
  for (const [key, value] of Object.entries(fixture.fields ?? {})) manual.set(key, value);
  return { manual, service: formFor(prepared), prepared, manualClaims };
}

async function workerPreparation(portal: GenericClaimStatusServicePortalId, form: FormData) {
  try {
    const credentials = await credentialsFor(portal, form);
    const file = form.get(claimStatusServicePortalConfigs[portal].claimField) as File;
    const rows = portal === "uhc"
      ? await prepareUhcRuntimeClaims(form, String(form.get("clientType") || "minimax"))
      : await readPortalClaimRows(portal, Buffer.from(await file.arrayBuffer()));
    return { credentials, rows: stripCorrelation(rows), error: null };
  } catch (error) {
    return { credentials: null, rows: null, error: error instanceof Error ? error.message : String(error) };
  }
}

const missingField: Record<GenericClaimStatusServicePortalId, string> = {
  aerial: "Member ID", "all-care": "ID", astrona: "Patient Name", "blue-shield": "Subscriber ID",
  cigna: "Procedure Code", kaiser: "Procedure Code", "my-family": "Service Date", physicians: "Subscriber ID",
  medpoint: "Patient Name", "optum-pro": "CPT Code", regal: "Patient Name", uhc: "Group Name", waystar: "Member Name",
};
const fatalClaimPortals = new Set(["medpoint", "optum-pro", "regal", "uhc"]);

for (const portal of Object.keys(fixtures) as GenericClaimStatusServicePortalId[]) {
  for (const mixed of [false, true]) {
    test(`${portal}: ${mixed ? "valid/invalid/valid batch" : "single invalid claim"} has identical worker preparation and severity`, async () => {
      const valid = fixtures[portal].data;
      const invalid = { ...valid };
      delete invalid[missingField[portal]];
      const rows = mixed ? [valid, invalid, valid] : [invalid];
      // Ingestion must accept claims even when the native worker parser will
      // reject them. The worker, not the service API, owns fatal-vs-row policy.
      const { manual, service, prepared } = await independentPair(portal, rows);
      assert.equal(prepared.claimCount, rows.length);
      assert.deepEqual(JSON.parse(prepared.claimRowsJson).map((row: Record<string, unknown>) => row["Client Row Ref"]), rows.map((_, i) => `claim-${i + 1}`));
      const manualResult = await workerPreparation(portal, manual);
      const serviceResult = await workerPreparation(portal, service);
      assert.deepEqual(serviceResult, manualResult);
      if (fatalClaimPortals.has(portal)) assert.ok(serviceResult.error, "native fatal validation must remain enforced");
      else {
        assert.equal(serviceResult.error, null);
        const resultRows = serviceResult.rows as Array<Record<string, unknown>>;
        const bad = resultRows[mixed ? 1 : 0];
        assert.ok(bad.validationStatus === "invalid" || bad.validation_status === "invalid" || bad.error, "native row validation must remain enforced");
        assert.equal(resultRows.length, rows.length);
      }
    });
  }

  test(`${portal}: row filtering matches manual workbooks and never rejects the service envelope`, async () => {
    const { manual, service, prepared } = await independentPair(portal, [fixtures[portal].data, { "Unrecognized Notes": "No portal search fields" }, fixtures[portal].data]);
    assert.equal(prepared.claimCount, 3);
    const manualResult = await workerPreparation(portal, manual);
    assert.deepEqual(await workerPreparation(portal, service), manualResult);
    // Native readers may drop the middle row, preserve it as invalid, or
    // reject the job. Do not invent a separate service row-filtering policy.
  });

  test(`${portal}: invalid claim batches retain service reservation, retry and contract validation`, async () => {
    let saved: ExistingServiceJob | null = null;
    let prepares = 0;
    let creates = 0;
    const bad = { ...fixtures[portal].data };
    delete bad[missingField[portal]];
    const body = {
      projectId: portal === "aerial" ? "PMG" : "medrevenu", portal,
      credentials: { ...creds, ...fixtures[portal].credentials },
      claims: [{ client_row_ref: "R1", data: fixtures[portal].data }, { client_row_ref: "R2", data: bad }, { client_row_ref: "R3", data: fixtures[portal].data }],
    };
    const submit = () => reserveServiceSubmission({
      clientSystem: "AR_WORKFLOW", clientExecutionId: "E1", idempotencyKey: "K1", portalId: portal, body,
      authenticatedToken: "dummy-service-token-at-least-32-characters", find: async () => saved,
      prepare: async () => { prepares++; return prepareGenericClaimStatusServiceInput(portal, body); },
      createJobId: () => "job-1", isUniqueViolation: () => false,
      create: async (jobId, prepared, fingerprint, salt) => {
        creates++; assert.equal(prepared.claimCount, 3);
        saved = { jobId, status: "preparing", clientExecutionId: "E1", portalId: portal, metadata: { requestHash: fingerprint, requestHashVersion: 3, requestHashSalt: salt } };
      },
    });
    assert.equal((await submit()).existing, false);
    assert.equal((await submit()).existing, true);
    assert.deepEqual({ prepares, creates }, { prepares: 1, creates: 1 });
    for (const claims of [[], [{ client_row_ref: "duplicate", data: {} }, { client_row_ref: "duplicate", data: {} }], [{ client_row_ref: "R1", data: { invalid: [] } }]]) {
      await assert.rejects(prepareGenericClaimStatusServiceInput(portal, { ...body, claims }));
    }
  });
}

async function routingFor(portal: "all-care" | "astrona" | "blue-shield", form: FormData) {
  if (portal === "all-care") {
    const input = await parseAllCareInput(form);
    return routeAllCareRows(readAllCareInputRows(input.inputWorkbookBuffer), readAllCareCredentials(input.credentialWorkbookBuffer));
  }
  if (portal === "astrona") {
    const input = await parseAstronaInput(form);
    return routeAstronaRows(readAstronaInputRows(input.inputWorkbookBuffer), readAstronaCredentials(input.credentialWorkbookBuffer));
  }
  const input = await parseBlueShieldInput(form);
  return routeBlueShieldRowsByCredentials(readBlueShieldInputWorkbook(input.inputWorkbookBuffer), input.credentialWorkbookBuffer);
}

for (const portal of ["all-care", "astrona", "blue-shield"] as const) {
  test(`${portal}: one unmatched account is routed per row without rejecting the other claims`, async () => {
    const valid = fixtures[portal].data;
    const invalid = { ...valid, Group: "UNMATCHED", IPA: "UNMATCHED", "Provider Group": "UNMATCHED", "Group Name": "UNMATCHED" };
    const { manual, service } = await independentPair(portal, [valid, invalid, valid], {
      group: portal === "blue-shield" ? "IUMG" : "Alpha", payer: "Aetna",
    });
    const manualRouting = await routingFor(portal, manual);
    const serviceRouting = await routingFor(portal, service);
    assert.deepEqual(stripCorrelation(serviceRouting), stripCorrelation(manualRouting));
    assert.equal(serviceRouting.unmappedRows.length, 1);
    assert.equal(serviceRouting.batches.flatMap(batch => batch.rows).length, 2);
  });
}

test("Aerial positional fallback ignores correlation metadata and preserves sparse cell indexes", async () => {
  // Nonstandard legacy header names use physical columns A/H/K.
  const data = { c0: "CLAIM-1", c1: null, c2: null, c3: null, c4: null, c5: null, c6: null, c7: "00123", c8: null, c9: null, c10: "01/02/2026" };
  const prepared = await prepareGenericClaimStatusServiceInput("aerial", { projectId: "PMG", credentials: { ...creds, login_url: "https://example.test" }, claims: [{ client_row_ref: "R1", data }] });
  const manualRows = await readPortalClaimRows("aerial", await excel([data]));
  const serviceRows = await readPortalClaimRows("aerial", prepared.files[0].buffer);
  assert.deepEqual(serviceRows, manualRows);
  assert.equal(serviceRows[0]["Subscriber No"], "00123");
  assert.equal(serviceRows[0]["Service Date"], "01/02/2026");
});

test("Aerial's previously accepted JSON separator aliases are handled by the shared workbook parser", async () => {
  const { manual, service } = await independentPair("aerial", [{ Group_Name: "Alpha", Claim_Number: "C1", Member_ID: "00123", Date_Of_Service: "01/02/2026" }]);
  const actual = await workerPreparation("aerial", service);
  assert.deepEqual(actual, await workerPreparation("aerial", manual));
  assert.equal(actual.error, null);
  const row = (actual.rows as Array<Record<string, unknown>>)[0];
  assert.equal(row.Group, "Alpha");
  assert.equal(row["Subscriber No"], "00123");
  assert.equal(row["Service Date"], "01/02/2026");
  assert.equal(row.validation_status, "valid");
});

test("credential scope inference is explicit, shared, unambiguous and never overwrites an account", async () => {
  const ordinary = asArrayBuffer(await excel([{ Username: "test", Password: "dummy" }]));
  assert.equal(resolveClaimCredentialScopes(ordinary, () => { throw new Error("must not infer ordinary workbook scopes"); }), ordinary);
  assert.throws(() => readAllCareCredentials(ordinary), /missing Group/);
  const directive = asArrayBuffer(await excel([{ Username: "test", Password: "dummy", URL: "https://example.test", [CLAIM_CREDENTIAL_SCOPE_COLUMNS.group]: true, [CLAIM_CREDENTIAL_SCOPE_COLUMNS.payer]: true }]));
  const resolved = resolveClaimCredentialScopes(directive, () => [{ group: "Alpha", payer: "Aetna" }, { group: "", payer: "" }]);
  assert.equal(readAllCareCredentials(resolved)[0].group, "Alpha");
  assert.throws(() => resolveClaimCredentialScopes(directive, () => [{ group: "Alpha" }, { group: "Beta" }]), /cannot be inferred uniquely/);
  const explicit = asArrayBuffer(await excel([{ Group: "Explicit", "Responsible Payer": "Aetna", Username: "test", Password: "dummy", URL: "https://example.test", [CLAIM_CREDENTIAL_SCOPE_COLUMNS.group]: true }]));
  assert.equal(readAllCareCredentials(resolveClaimCredentialScopes(explicit, () => [{ group: "Other" }]))[0].group, "Explicit");
});

for (const portal of ["all-care", "astrona"] as const) {
  test(`${portal}: invalid row scope cannot make defaults ambiguous for runnable claims`, async () => {
    const valid = fixtures[portal].data;
    const invalid = { ...valid, [portal === "all-care" ? "IPA" : "Provider Group"]: "INVALID-ROW-GROUP" };
    delete invalid[missingField[portal]];
    const { manual, service } = await independentPair(portal, [valid, invalid, valid]);
    const result = await workerPreparation(portal, service);
    assert.deepEqual(result, await workerPreparation(portal, manual));
    assert.equal(result.error, null);
    assert.equal((result.rows as Array<Record<string, unknown>>)[1].validationStatus, "invalid");
  });
}

test("Aerial Citrus Valley and PMG share subportal and credential preparation across transports", async () => {
  const rows = [{ Group: "Alpha", "Member ID": "00123", DOS: "01/02/2026" }, { Group: "Alpha", DOS: "01/02/2026" }];
  for (const projectId of ["PMG", "Citrus Valley"]) {
    const prepared = await prepareGenericClaimStatusServiceInput("aerial", { projectId, credentials: { ...creds, login_url: "https://example.test" }, claims: rows.map((data, i) => ({ client_row_ref: `R${i}`, data })) });
    const manual = new FormData();
    manual.set("aerialSubportal", projectId);
    manual.set("inputExcel", new File([new Uint8Array(await excel(rows))], prepared.claimFileName));
    manual.set("credentialExcel", new File([new Uint8Array(await excel([{ "Sub portal": projectId, Group: "Alpha", URL: "https://example.test", ...login }]))], "manual.xlsx"));
    assert.deepEqual(await workerPreparation("aerial", formFor(prepared)), await workerPreparation("aerial", manual));
  }
});

test("Blue Shield's member/DOS deduplication is identical for manual and service rows", async () => {
  const { createUniqueMemberWorkItems } = await import("../../workflows/claim-status/portals/blue-shield/input");
  const { manual, service } = await independentPair("blue-shield", [fixtures["blue-shield"].data, fixtures["blue-shield"].data]);
  const read = async (form: FormData) => createUniqueMemberWorkItems(readBlueShieldInputWorkbook(await (form.get("inputExcel") as File).arrayBuffer()));
  assert.deepEqual(await read(service), await read(manual));
  assert.equal((await read(service)).length, 1);
  assert.deepEqual((await read(service))[0].rowIds, [2, 3]);
});

test("parity coverage includes every portal in the manual worker registry", () => {
  assert.deepEqual(Object.keys(servicePortals).sort(), listClaimStatusPortals().map(portal => portal.id).sort());
  assert.deepEqual(Object.keys(fixtures).sort(), Object.keys(servicePortals).filter(id => id !== "availity" && id !== "iehp").sort());
});

for (const portal of ["all-care", "astrona", "blue-shield"] as const) {
  test(`${portal}: multiple credential accounts keep the same group/payer routing`, async () => {
    const fixture = fixtures[portal];
    const scopeField = portal === "all-care" ? "IPA" : portal === "astrona" ? "Provider Group" : "Group Name";
    const groups = portal === "blue-shield" ? ["IUMG", "OTHER"] : ["Alpha", "Beta"];
    const claims = [fixture.data, { ...fixture.data, [scopeField]: groups[1] }];
    const accounts = groups.map((group, i) => ({ ...creds, ...fixture.credentials, username: `test-account-${i}`, group, payer: "Aetna" }));
    const prepared = await prepareGenericClaimStatusServiceInput(portal, { credentials: { accounts }, claims: claims.map((data, i) => ({ client_row_ref: `R${i}`, data })) });
    const manual = new FormData();
    manual.set("inputExcel", new File([new Uint8Array(await excel(claims))], prepared.claimFileName));
    manual.set("credentialExcel", new File([new Uint8Array(await excel(groups.map((Group, i) => ({ ...fixture.login, Group, Username: `test-account-${i}` }))))], "manual-login.xlsx"));
    const serviceRouting = await routingFor(portal, formFor(prepared));
    assert.deepEqual(stripCorrelation(serviceRouting), stripCorrelation(await routingFor(portal, manual)));
    assert.equal(serviceRouting.batches.length, 2);
    assert.equal(serviceRouting.unmappedRows.length, 0);
  });
}
