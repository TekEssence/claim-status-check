import test from "node:test";
import assert from "node:assert/strict";
import { isJobInputRequest, mergeJobLogs } from "./job-event-display";

test("job detail keeps lifecycle and worker logs together instead of hiding lifecycle when CloudWatch exists", () => {
  assert.deepEqual(mergeJobLogs([
    { payload: { type: "log", message: "Inputs ready" } },
    { payload: { type: "log", message: "Logging in" } },
    { payload: { type: "input_submitted" } },
    { payload: { type: "input_consumed" } },
  ], ["Logging in", "Searching"]), ["Inputs ready", "Logging in", "Verification response submitted. Waiting for worker acknowledgement.", "Verification response received by worker. Processing resumed.", "Searching"]);
});

test("all existing input prompt types are recognized for replay filtering", () => {
  for (const type of ["input_request", "otp_request", "otp_required", "provider_options"]) assert.equal(isJobInputRequest({ type }), true);
  assert.equal(isJobInputRequest({ type: "log" }), false);
});
