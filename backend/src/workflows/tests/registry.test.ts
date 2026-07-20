import assert from "node:assert/strict";
import test from "node:test";
import { getAutomationRunner } from "../registry";

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

test("eligibility resolves Waystar without requiring a payer selection", () => {
  const runner = getAutomationRunner("eligibility-verification", "waystar");

  assert.equal(runner.workflowId, "eligibility-verification");
  assert.equal(runner.portalId, "waystar");
  assert.equal(runner.payerId, undefined);
  assert.equal(runner.name, "Waystar Eligibility Verification");
});
