import test from "node:test";
import assert from "node:assert/strict";
import { isJobInputRequest, mergeJobLogs } from "./job-event-display";

test("job detail logs come only from CloudWatch, keeping repeated messages and the newest 200", () => {
  assert.deepEqual(mergeJobLogs([
    { payload: { type: "log", message: "Inputs ready" } },
    { payload: { type: "log", message: "Logging in" } },
    { payload: { type: "input_submitted" } },
    { payload: { type: "input_consumed" } },
  ], ["Logging in", "Searching", "Searching"]), ["Logging in", "Searching", "Searching"]);
  const logs = Array.from({ length: 1000 }, (_, index) => `Log ${index + 1}`);
  assert.deepEqual(mergeJobLogs([], logs), logs.slice(800));
  assert.deepEqual(mergeJobLogs([{ payload: { type: "log", message: "Old DB log" } }]), []);
});

test("all existing input prompt types are recognized for replay filtering", () => {
  for (const type of ["input_request", "otp_request", "otp_required", "provider_options"]) assert.equal(isJobInputRequest({ type }), true);
  assert.equal(isJobInputRequest({ type: "log" }), false);
});
