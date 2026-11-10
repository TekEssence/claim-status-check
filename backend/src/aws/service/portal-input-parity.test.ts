import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { prepareGenericClaimStatusServiceInput, claimStatusServicePortalConfigs, type GenericClaimStatusServicePortalId } from "./generic-claim-status-input";
import { readServicePortalClaims, asArrayBuffer } from "./claim-status-workbook-validation";
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
    assert.deepEqual(projection(await readServicePortalClaims(portal, prepared.files[0].buffer)), projection(await readServicePortalClaims(portal, manualClaims)));
    assert.equal(prepared.claimCount, 1);
  });
}

test("Aerial validates subportal and group matching with the native credential reader", async () => {
  const request = { projectId: "Citrus Valley", credentials: { ...creds, login_url: "https://example.test" }, claims: [{ client_row_ref: "claim-1", data: { Group: "Alpha", "Member ID": "00123", DOS: "01/02/2026" } }] };
  const prepared = await prepareGenericClaimStatusServiceInput("aerial", request);
  assert.equal(prepared.formFields.aerialSubportal, "citrus-valley");
  await assert.rejects(prepareGenericClaimStatusServiceInput("aerial", { ...request, credentials: { ...request.credentials, group: "Other" } }), /No matching Aerial/);
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
