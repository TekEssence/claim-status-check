import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ExcelJS from "exceljs";
import { prepareGenericClaimStatusServiceInput } from "../service/generic-claim-status-input";
import { generateIehpServiceInput, validateIehpServiceInput } from "../service/iehp-input";
import { loadDefaultUhcProviderMappings, prepareUhcRuntimeClaims, readUhcProviderMappings } from "../../workflows/claim-status/portals/uhc/runtime-input";
import { getIehpClaimSearchFields, parseIehpClaimStatusInput } from "../../workflows/claim-status/portals/iehp/input";
import { parseUhcClaimRows } from "../../workflows/claim-status/portals/uhc/workbook-output";
import { isInputRequest, isPersistentWorkflowEvent, persistentWorkflowEventPayload, persistentWorkflowEventType } from "../runtime/job-event-policy";
import { deliverWorkerInput } from "./input-delivery";
import { createScrapeJob, waitForScrapeJobInput, submitScrapeJobInput } from "../../jobs/job-store";
import { prepareUhcAutomationRun } from "../../workflows/claim-status/portals/uhc/claim-status-job";
import type { ScraperContext } from "../../workflows/claim-status/types";

test("UHC manual and service submissions use the same workbook parser and default provider mappings", async () => {
  const prepared = await prepareGenericClaimStatusServiceInput("uhc", {
    projectId: "MedRevenu", credentials: { login_url: "https://secure.uhcprovider.com", username: "test", password: "test" },
    claims: [{ client_row_ref: "claim-1", data: { Group: "BZA", "Subscriber No": "001234", "Patient DOB": "01/02/1990", "Service Date": "08/21/2026", "CPT Code": "99214", Modifier: "25" } }],
  });
  const service = new FormData();
  for (const file of prepared.files) service.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
  service.set("claimRows", prepared.claimRowsJson);
  const manual = new FormData();
  manual.set("claimExcel", service.get("claimExcel")!);
  // A stale frontend-generated JSON payload must not override the workbook.
  manual.set("claimRows", JSON.stringify([{ subscriberNo: "wrong" }]));
  const actual = await prepareUhcRuntimeClaims(service, "medrevenu");
  assert.deepEqual(actual, await prepareUhcRuntimeClaims(manual, "medrevenu"));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(prepared.files[0].buffer as never);
  assert.deepEqual(actual, parseUhcClaimRows(workbook.worksheets[0], { requirePatientDob: false }));
  assert.equal(actual[0].subscriberNo, "001234");
  assert.equal(actual[0]["CPT Code"], "99214");
  assert.equal(actual[0].Modifier, "25");
  assert.equal(actual[0]["Client Row Ref"], "claim-1");
  const mappings = await loadDefaultUhcProviderMappings();
  assert.ok(mappings.some(mapping => mapping.group === "BZA" && mapping.careProvider));
  const context: ScraperContext = { jobId: crypto.randomUUID(), portalId: "uhc", emit: async () => {}, log: async () => {} };
  manual.set("loginExcel", service.get("loginExcel")!);
  manual.set("clientType", "medrevenu");
  manual.set("providerMappings", JSON.stringify(mappings));
  service.set("clientType", "MedRevenu");
  const manualRun = await prepareUhcAutomationRun(manual, context);
  const serviceRun = await prepareUhcAutomationRun(service, context);
  for (const key of ["username", "password", "baseUrl", "claims", "clientType", "providerMappings", "startIndex", "browserType", "attempt"] as const) {
    assert.deepEqual(serviceRun[key], manualRun[key]);
  }
  const job = createScrapeJob(context.jobId);
  const events: Record<string, unknown>[] = [];
  const otpRun = await prepareUhcAutomationRun(service, { ...context, emit: async event => { events.push(event); } });
  const waitingForOtp = otpRun.requestOtp!();
  // The waiter is registered immediately after the request event is delivered.
  await new Promise(resolve => setImmediate(resolve));
  const challenge = events.find(event => event.type === "otp_request")!;
  assert.ok(challenge.inputName);
  assert.equal(deliverWorkerInput(job.id, { commandType: String(challenge.inputName), payload: { value: "123456" } }, submitScrapeJobInput), true);
  assert.equal(await waitingForOtp, "123456");
  assert.equal(JSON.stringify(events).includes("123456"), false);
  const dockerfile = await fs.readFile("Dockerfile.worker", "utf8");
  assert.match(dockerfile, /COPY public\/provider-mappings\/uhc-provider-mappings.xlsx/);
});

test("bad provider configuration fails explicitly before browser login", async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet("Mappings").addRow(["Group"]);
  await assert.rejects(readUhcProviderMappings(new Uint8Array(await book.xlsx.writeBuffer())), /requires Group/);
});

test("IEHP manual and service submissions use the same workbook data, row indexes and CPT", async () => {
  const input = validateIehpServiceInput({ credentials: { login_url: "https://example.test", username: "test", password: "test" },
    claims: [{ client_row_ref: "claim-1", data: { "Member Policy ID": "001234", "Date Of Service": "08/31/2026", "CPT Code": "99445", Modifier: "" } }] });
  const prepared = await generateIehpServiceInput(input);
  const manual = new FormData();
  manual.set("claimExcel", new File([new Uint8Array(prepared.claimWorkbook)], "claims.xlsx"));
  manual.set("loginExcel", new File([new Uint8Array(prepared.loginWorkbook)], "login.xlsx"));
  const service = new FormData();
  for (const [key, value] of manual.entries()) service.set(key, value);
  service.set("claimRows", prepared.claimRowsJson);
  const actual = await parseIehpClaimStatusInput(manual);
  assert.deepEqual(actual, await parseIehpClaimStatusInput(service));
  assert.equal(actual.claimRows[0]["CPT Code"], "99445");
  assert.equal(actual.claimRows[0].__original_index, 0);
});

test("IEHP service accepts the worker's Member ID and DOS header aliases", async () => {
  const input = validateIehpServiceInput({ credentials: { login_url: "https://example.test", username: "test", password: "test" },
    claims: [{ client_row_ref: "claim-1", data: { "Member ID": "00123", DOS: "08/31/2026", "CPT Code": "99445" } }] });
  assert.deepEqual(getIehpClaimSearchFields(input.claims[0].data), { memberPolicyId: "00123", dosValue: "08/31/2026" });
});

test("manual and service jobs persist input prompts and acknowledgements without log history or input values", () => {
  for (const type of ["otp_request", "otp_required", "input_request", "provider_options", "input_submitted", "input_consumed"]) {
    const event = { type, message: "Stage message", inputName: "input-1", value: "secret-otp", password: "secret-password" };
    assert.equal(isPersistentWorkflowEvent(event), true);
    assert.equal(JSON.stringify(persistentWorkflowEventPayload(event)).includes("secret-"), false);
  }
  for (const type of ["log", "warning", "error", "progress", "row_progress"]) assert.equal(isPersistentWorkflowEvent({ type }), false);
  assert.equal(isInputRequest({ type: "provider_options" }), true);
  assert.equal(persistentWorkflowEventType({ type: "provider_options" }), "input_request");
});

test("submitted OTP resumes the existing named waiter and cannot satisfy a different challenge", async () => {
  const job = createScrapeJob(crypto.randomUUID());
  const waiting = waitForScrapeJobInput(job.id, "uhc_otp_one", 1000);
  assert.equal(deliverWorkerInput(job.id, { commandType: "uhc_otp_other", payload: { value: "123456" } }, submitScrapeJobInput), false);
  assert.equal(deliverWorkerInput(job.id, { commandType: "uhc_otp_one", payload: { value: "123456" } }, submitScrapeJobInput), true);
  assert.equal(await waiting, "123456");
  assert.equal(deliverWorkerInput(job.id, { commandType: "uhc_otp_one", payload: { value: "123456" } }, submitScrapeJobInput), false);
});
