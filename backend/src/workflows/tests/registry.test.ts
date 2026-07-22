import assert from "node:assert/strict";
import test from "node:test";
import { getAutomationRunner } from "../registry";
import { getClaimStatusScraper } from "../claim-status/registry";
import { WORKFLOW_IDS } from "../types";

test("claim status portals resolve through the workflow registry", () => {
  const runner = getAutomationRunner("claim-status", "iehp");

  assert.equal(runner.workflowId, "claim-status");
  assert.equal(runner.portalId, "iehp");
  assert.equal(runner.name, "IEHP Claim Status");
});

test("eligibility resolves Waystar without requiring a payer selection", () => {
  const runner = getAutomationRunner("eligibility-verification", "waystar");

  assert.equal(runner.workflowId, "eligibility-verification");
  assert.equal(runner.portalId, "waystar");
  assert.equal(runner.payerId, undefined);
  assert.equal(runner.name, "Waystar Eligibility Verification");
});

test("payment EOB download is recognized as a workflow ID", () => {
  assert.ok(WORKFLOW_IDS.includes("payment-eob-download"));
});

test("payment EOB resolves Availity Remittance runner", () => {
  const runner = getAutomationRunner("payment-eob-download", "availity-remittance");

  assert.equal(runner.workflowId, "payment-eob-download");
  assert.equal(runner.portalId, "availity-remittance");
  assert.equal(runner.name, "Availity Remittance EOB Download");
});

test("claim status registry behavior remains unchanged", () => {
  const scraper = getClaimStatusScraper("iehp");

  assert.equal(scraper.id, "iehp");
  assert.equal(scraper.name, "IEHP Claim Status");
});

test("payment EOB validation requires credentialExcel", () => {
  const runner = getAutomationRunner("payment-eob-download", "availity-remittance");
  const formData = new FormData();
  formData.append("referenceExcel", new File(["reference"], "reference.xlsx"));

  assert.throws(
    () => runner.validateInput(formData),
    /Credential Excel is required/,
  );
});

test("payment EOB validation requires referenceExcel", () => {
  const runner = getAutomationRunner("payment-eob-download", "availity-remittance");
  const formData = new FormData();
  formData.append("credentialExcel", new File(["credential"], "credential.xlsx"));

  assert.throws(
    () => runner.validateInput(formData),
    /Reference Excel is required/,
  );
});

test("valid payment EOB shell job completes successfully", async () => {
  const runner = getAutomationRunner("payment-eob-download", "availity-remittance");
  const formData = new FormData();
  formData.append("credentialExcel", new File(["credential"], "credential.xlsx"));
  formData.append("referenceExcel", new File(["reference"], "reference.xlsx"));
  const input = runner.validateInput(formData);
  const logs: string[] = [];
  const events: Record<string, unknown>[] = [];

  await runner.run(input, {
    jobId: "payment-eob-shell-test",
    workflowId: "payment-eob-download",
    portalId: "availity-remittance",
    log: async (event) => {
      logs.push(event.message);
    },
    emit: async (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(events, [{ type: "progress", completed: 1, total: 1 }]);
  assert.ok(logs.some((message) => message.includes("Payment EOB input validation completed")));
  assert.ok(logs.some((message) => message.includes("Portal automation is not implemented yet")));
});
