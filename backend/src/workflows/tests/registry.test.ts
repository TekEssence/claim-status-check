import assert from "node:assert/strict";
import test from "node:test";
import { getAutomationRunner } from "../registry";
import { getClaimStatusScraper } from "../claim-status/registry";
import type { PaymentEobRunInput } from "../payment-eob-download/types";
import { WORKFLOW_IDS } from "../types";

test("claim status portals resolve through the workflow registry", () => {
  const runner = getAutomationRunner("claim-status", "iehp");

  assert.equal(runner.workflowId, "claim-status");
  assert.equal(runner.portalId, "iehp");
  assert.equal(runner.name, "IEHP Claim Status");
});

test("claim status resolves Astrona as an independent portal", () => {
  const runner = getAutomationRunner("claim-status", "astrona");

  assert.equal(runner.workflowId, "claim-status");
  assert.equal(runner.portalId, "astrona");
  assert.equal(runner.name, "Astrona Claim Status");
});

test("claim status resolves All Care as an independent portal", () => {
  const runner = getAutomationRunner("claim-status", "all-care");

  assert.equal(runner.workflowId, "claim-status");
  assert.equal(runner.portalId, "all-care");
  assert.equal(runner.name, "All Care Claim Status");
});

test("claim status resolves Waystar through the workflow registry", () => {
  const runner = getAutomationRunner("claim-status", "waystar");

  assert.equal(runner.workflowId, "claim-status");
  assert.equal(runner.portalId, "waystar");
  assert.equal(runner.name, "Waystar Claim Status");
});

test("claim status resolves Medpoint through the workflow registry", () => {
  const runner = getAutomationRunner("claim-status", "medpoint");

  assert.equal(runner.workflowId, "claim-status");
  assert.equal(runner.portalId, "medpoint");
  assert.equal(runner.name, "Medpoint Claim Status");
});

test("claim status resolves new portal additions", () => {
  for (const portal of ["cigna", "kaiser", "my-family", "physicians", "uhc"]) {
    const runner = getAutomationRunner("claim-status", portal);
    assert.equal(runner.workflowId, "claim-status");
    assert.equal(runner.portalId, portal);
  }
});

test("eligibility resolves Waystar without requiring a payer selection", () => {
  const runner = getAutomationRunner("eligibility-verification", "waystar");

  assert.equal(runner.workflowId, "eligibility-verification");
  assert.equal(runner.portalId, "waystar");
  assert.equal(runner.payerId, undefined);
  assert.equal(runner.name, "Waystar Eligibility Verification");
});

test("eligibility resolves Availity independently from claim status", () => {
  const runner = getAutomationRunner("eligibility-verification", "availity");

  assert.equal(runner.workflowId, "eligibility-verification");
  assert.equal(runner.portalId, "availity");
  assert.equal(runner.name, "Availity Eligibility Verification");
});

test("eligibility resolves UHC with the UHC/Wellmed payer", () => {
  const runner = getAutomationRunner("eligibility-verification", "uhc", "uhc-wellmed");

  assert.equal(runner.workflowId, "eligibility-verification");
  assert.equal(runner.portalId, "uhc");
  assert.equal(runner.payerId, "uhc-wellmed");
  assert.equal(runner.name, "UHC/Wellmed Eligibility Verification");
});

test("eligibility resolves AARP Medicare Advantage Wellmed through the shared UHC workflow", () => {
  const runner = getAutomationRunner(
    "eligibility-verification",
    "uhc",
    "aarp-medicare-advantage-wellmed",
  );

  assert.equal(runner.workflowId, "eligibility-verification");
  assert.equal(runner.portalId, "uhc");
  assert.equal(runner.payerId, "aarp-medicare-advantage-wellmed");
  assert.equal(runner.name, "AARP Medicare Advantage Wellmed Eligibility Verification");
});

test("eligibility resolves United Healthcare Dual Complete through the shared UHC workflow", () => {
  const runner = getAutomationRunner(
    "eligibility-verification",
    "uhc",
    "united-healthcare-dual-complete",
  );

  assert.equal(runner.workflowId, "eligibility-verification");
  assert.equal(runner.portalId, "uhc");
  assert.equal(runner.payerId, "united-healthcare-dual-complete");
  assert.equal(runner.name, "United Healthcare Dual Complete Eligibility Verification");
});

for (const payer of [
  { id: "united-health-care", name: "United Health Care" },
  { id: "uhc-medicare-advantage", name: "UHC Medicare Advantage" },
]) {
  test(`eligibility resolves ${payer.name} through the shared UHC workflow`, () => {
    const runner = getAutomationRunner("eligibility-verification", "uhc", payer.id);

    assert.equal(runner.workflowId, "eligibility-verification");
    assert.equal(runner.portalId, "uhc");
    assert.equal(runner.payerId, payer.id);
    assert.equal(runner.name, `${payer.name} Eligibility Verification`);
  });
}

test("payment EOB download is recognized as a workflow ID", () => {
  assert.ok(WORKFLOW_IDS.includes("payment-eob-download"));
});

test("payment posting is recognized as a workflow ID", () => {
  assert.ok(WORKFLOW_IDS.includes("payment-posting"));
});

test("payment posting resolves AdvancedMD runner", () => {
  const runner = getAutomationRunner("payment-posting", "advancedmd");

  assert.equal(runner.workflowId, "payment-posting");
  assert.equal(runner.portalId, "advancedmd");
  assert.equal(runner.name, "AdvancedMD Payment Posting");
});

test("payment posting rejects unknown portals", () => {
  assert.throws(
    () => getAutomationRunner("payment-posting", "missing-portal"),
    /Unknown portal: missing-portal/,
  );
});

test("payment EOB resolves Availity Remittance runner", () => {
  const runner = getAutomationRunner("payment-eob-download", "availity-remittance");

  assert.equal(runner.workflowId, "payment-eob-download");
  assert.equal(runner.portalId, "availity-remittance");
  assert.equal(runner.name, "Availity Remittance EOB Download");
});

test("payment EOB resolves Zelis runner", () => {
  const runner = getAutomationRunner("payment-eob-download", "zelis");

  assert.equal(runner.workflowId, "payment-eob-download");
  assert.equal(runner.portalId, "zelis");
  assert.equal(runner.name, "Zelis Remittance EOB Download");
});

test("payment EOB resolves Jopari runner", () => {
  const runner = getAutomationRunner("payment-eob-download", "jopari");
  assert.equal(runner.workflowId, "payment-eob-download");
  assert.equal(runner.portalId, "jopari");
  assert.equal(runner.name, "Jopari Payment EOB Download");
});

test("claim status registry behavior remains unchanged", async () => {
  const scraper = await getClaimStatusScraper("iehp");

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

test("payment EOB validation accepts required workbook uploads", () => {
  const runner = getAutomationRunner("payment-eob-download", "availity-remittance");
  const formData = new FormData();
  formData.append("credentialExcel", new File(["credential"], "credential.xlsx"));
  formData.append("referenceExcel", new File(["reference"], "reference.xlsx"));

  const input = runner.validateInput(formData) as PaymentEobRunInput;

  assert.equal(input.credentialExcel.name, "credential.xlsx");
  assert.equal(input.referenceExcel?.name, "reference.xlsx");
});

test("Zelis payment EOB validation only requires credentialExcel", () => {
  const runner = getAutomationRunner("payment-eob-download", "zelis");
  const formData = new FormData();
  formData.append("credentialExcel", new File(["credential"], "credential.xlsx"));

  const input = runner.validateInput(formData) as PaymentEobRunInput;

  assert.equal(input.credentialExcel.name, "credential.xlsx");
  assert.equal(input.referenceExcel, undefined);
});
