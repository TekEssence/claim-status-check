import test from "node:test";
import assert from "node:assert/strict";
import { runAvailityClaimStatusJob } from "./claim-status-job";
import { generateAvailityServiceInput, validateAvailityServiceInput } from "../../../../aws/service/availity-input";
import { normalizeAvailityServiceWorkbook } from "../../../../aws/service/availity-results";
import { completedWorkerWorkbookResults } from "../../../../aws/worker/claim-result-publisher";

test("all unsupported payer rows finalize with submitted-row progress without opening a browser", async () => {
  const refs = ["unsupported-1", "unsupported-2"];
  const generated = await generateAvailityServiceInput(validateAvailityServiceInput({
    credentials: { login_url: "https://example.test", username: "fixture-user", password: "dummy-password", totp_secret: "DUMMYBASE32" },
    claims: refs.map(client_row_ref => ({ client_row_ref, data: { "Payer Name": "Unsupported fixture insurer" } })),
  }));
  const form = new FormData();
  form.set("inputExcel", new File([new Uint8Array(generated.claimWorkbook)], "claims.xlsx"));
  form.set("credentialExcel", new File([new Uint8Array(generated.credentialWorkbook)], "login.xlsx"));
  const progress: Array<{ completed: unknown; total: unknown }> = [];
  const errors: string[] = [];
  let output: Uint8Array | undefined;
  await runAvailityClaimStatusJob(form, {
    jobId: "fixture-job", portalId: "availity", log: async () => {},
    emit: async event => {
      if (event.type === "progress") progress.push({ completed: event.completed, total: event.total });
      if (event.type === "error") errors.push(String(event.message));
      if (event.type === "file_download") output = new Uint8Array(Buffer.from(String(event.base64), "base64"));
    },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(progress, [{ completed: 0, total: 2 }, { completed: 2, total: 2 }]);
  assert.ok(output);
  const outcomes = await completedWorkerWorkbookResults(output, refs);
  assert.equal(outcomes.length, 2);
  assert.ok(outcomes.every(row => row.status === "SKIPPED" && row.error_category === "UNSUPPORTED_PAYER"));
  const summary = await normalizeAvailityServiceWorkbook(output, refs);
  assert.equal(summary.finalized_count, 2);
  assert.ok(summary.row_results.every(row => row.status === "FAILED" && row.error_category === "UNSUPPORTED_PAYER"));
});
