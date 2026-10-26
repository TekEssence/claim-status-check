import test from "node:test";
import assert from "node:assert/strict";
import {
  legacyServiceSubmissionFingerprint, lookupServiceSubmission, reserveServiceSubmission, serviceSubmissionFingerprint,
  ServiceSubmissionConflict, type ExistingServiceJob,
} from "./service-submission";
import { cancelServiceExecution, type CancellableServiceJob } from "./service-cancellation";

const token = "test-service-token-longer-than-thirty-two-characters";
const original = {
  client_system: "AR_WORKFLOW", client_execution_id: "E100", idempotency_key: "K100",
  deadline_at: "2026-10-24T00:00:00Z", workflow: "CLAIM_STATUS", portal: "iehp",
  credentials: { username: "account", password: "password-never-persist", totp_secret: "totp-never-persist" },
  claims: [{ client_row_ref: "R1", data: { member_id: "M1" } }],
};

function submissionHarness() {
  let job: ExistingServiceJob | null = null;
  let created = 0;
  let prepared = 0;
  const submit = (body: Record<string, unknown> = original, authenticatedToken = token) => reserveServiceSubmission({
    clientSystem: "AR_WORKFLOW", clientExecutionId: String(body.client_execution_id), idempotencyKey: "K100", portalId: "iehp",
    body, authenticatedToken,
    find: async () => job,
    prepare: async () => { prepared += 1; return "prepared-input"; },
    createJobId: () => `J${created + 1}`,
    create: async (jobId, _prepared, fingerprint, salt) => {
      created += 1;
      job = { jobId, status: "preparing", clientExecutionId: "E100", portalId: "iehp",
        metadata: { requestHash: fingerprint, requestHashVersion: 3, requestHashSalt: salt } };
    },
    isUniqueViolation: () => false,
  });
  return { submit, find: async () => job, counts: () => ({ created, prepared }) };
}

test("first submission reserves one job; identical and repeated retries reuse it before preparing inputs", async () => {
  const harness = submissionHarness();
  const first = await harness.submit();
  assert.deepEqual(first, { existing: false, jobId: "J1", prepared: "prepared-input" });
  for (let retry = 0; retry < 3; retry += 1) {
    const response = await harness.submit();
    assert.equal(response.existing, true);
    if (response.existing) assert.equal(response.job.jobId, "J1");
  }
  assert.deepEqual(harness.counts(), { created: 1, prepared: 1 });
});

test("same key with changed claim, credential, or execution configuration conflicts", async () => {
  const harness = submissionHarness();
  await harness.submit();
  await assert.rejects(harness.submit({ ...original, claims: [{ client_row_ref: "R2", data: { member_id: "M2" } }] }), ServiceSubmissionConflict);
  await assert.rejects(harness.submit({ ...original, credentials: { ...original.credentials, password: "different" } }), ServiceSubmissionConflict);
  await assert.rejects(harness.submit({ ...original, deadline_at: "2026-10-25T00:00:00Z" }), ServiceSubmissionConflict);
  await assert.rejects(harness.submit({ ...original, client_execution_id: "E101" }), ServiceSubmissionConflict);
  await assert.rejects(harness.submit({ ...original, workflow: "OTHER" }), ServiceSubmissionConflict);
  await assert.rejects(harness.submit({ ...original, portal: "availity" }), ServiceSubmissionConflict);
  assert.deepEqual(harness.counts(), { created: 1, prepared: 1 });
});

test("fingerprint is stable across JSON key order and stores no plaintext credential", () => {
  const salt = Buffer.alloc(16, 7).toString("base64url");
  const fingerprint = serviceSubmissionFingerprint(original, salt);
  const reordered = { claims: original.claims, credentials: { password: original.credentials.password,
    totp_secret: original.credentials.totp_secret, username: original.credentials.username },
  portal: original.portal, workflow: original.workflow, deadline_at: original.deadline_at,
  idempotency_key: original.idempotency_key, client_execution_id: original.client_execution_id,
  client_system: original.client_system };
  assert.equal(serviceSubmissionFingerprint(reordered, salt), fingerprint);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint.includes(original.credentials.password), false);
  assert.equal(fingerprint.includes(original.credentials.totp_secret), false);
});

test("identical retry survives service token rotation", async () => {
  const harness = submissionHarness();
  await harness.submit();
  const retry = await harness.submit(original, "rotated-service-token-also-longer-than-thirty-two-characters");
  assert.equal(retry.existing, true);
  if (retry.existing) assert.equal(retry.job.jobId, "J1");
  assert.deepEqual(harness.counts(), { created: 1, prepared: 1 });
});

test("new idempotency metadata contains no password or TOTP value", async () => {
  const harness = submissionHarness();
  await harness.submit();
  const metadata = JSON.stringify((await harness.find())?.metadata);
  assert.equal(metadata.includes(original.credentials.password), false);
  assert.equal(metadata.includes(original.credentials.totp_secret), false);
});

test("jobs created with the previous fingerprint remain idempotently retrievable", async () => {
  const oldJob: ExistingServiceJob = { jobId: "J-old", status: "running", clientExecutionId: "E100",
    portalId: "iehp", metadata: { requestHash: legacyServiceSubmissionFingerprint(original) } };
  const response = await reserveServiceSubmission({
    clientSystem: "AR_WORKFLOW", clientExecutionId: "E100", idempotencyKey: "K100", portalId: "iehp",
    body: original, authenticatedToken: token, find: async () => oldJob,
    prepare: async () => { throw new Error("should not prepare"); },
    createJobId: () => { throw new Error("should not create ID"); },
    create: async () => { throw new Error("should not create job"); },
    isUniqueViolation: () => false,
  });
  assert.equal(response.existing, true);
  if (response.existing) assert.equal(response.job.jobId, "J-old");
});

test("unique-index race returns the winning job without a second reservation", async () => {
  const salt = Buffer.alloc(16, 9).toString("base64url");
  const fingerprint = serviceSubmissionFingerprint(original, salt);
  let reads = 0;
  const winner: ExistingServiceJob = { jobId: "J1", status: "running", portalId: "iehp", clientExecutionId: "E100",
    metadata: { requestHash: fingerprint, requestHashVersion: 3, requestHashSalt: salt } };
  const result = await reserveServiceSubmission({
    clientSystem: "AR_WORKFLOW", clientExecutionId: "E100", idempotencyKey: "K100", portalId: "iehp",
    body: original, authenticatedToken: token,
    find: async () => ++reads === 1 ? null : winner,
    prepare: async () => "prepared-input", createJobId: () => "J2",
    create: async () => { throw Object.assign(new Error("duplicate"), { code: "23505" }); },
    isUniqueViolation: (error) => (error as { code?: string }).code === "23505",
  });
  assert.equal(result.existing, true);
  if (result.existing) assert.equal(result.job.jobId, "J1");
});

test("lookup recovers a lost response and gives found=false only for a definitive absence", async () => {
  const harness = submissionHarness();
  const missing = await lookupServiceSubmission({
    clientSystem: "AR_WORKFLOW", clientExecutionId: "E100", idempotencyKey: "K100",
    find: harness.find,
  });
  assert.deepEqual(missing, { found: false });
  await harness.submit(); // Simulate acceptance followed by a lost HTTP response.
  const accepted = await lookupServiceSubmission({
    clientSystem: "AR_WORKFLOW", clientExecutionId: "E100", idempotencyKey: "K100",
    find: harness.find,
  });
  assert.equal(accepted.found, true);
  if (accepted.found) assert.equal(accepted.job.jobId, "J1");
  await assert.rejects(lookupServiceSubmission({
    clientSystem: "AR_WORKFLOW", clientExecutionId: "OTHER", idempotencyKey: "K100",
    find: harness.find,
  }), ServiceSubmissionConflict);
  await assert.rejects(lookupServiceSubmission({
    clientSystem: "AR_WORKFLOW", clientExecutionId: "E100", idempotencyKey: "K100",
    find: async () => { throw new Error("database unavailable"); },
  }), /database unavailable/);
});

function cancellationHarness(initial: CancellableServiceJob["status"]) {
  const job = { jobId: "J1", status: initial, clientSystem: "AR_WORKFLOW" };
  let launchCount = 0;
  let stopRequests = 0;
  const cancel = () => cancelServiceExecution({
    find: async () => ({ ...job }),
    cancelBeforeLaunch: async () => {
      if (job.status !== "preparing" && job.status !== "queued") return false;
      job.status = "cancelled";
      return true;
    },
    markCancelling: async () => {
      if (!["starting", "running", "waiting_otp"].includes(job.status)) return false;
      job.status = "cancelling";
      return true;
    },
    requestWorkerCancel: async () => { stopRequests += 1; },
    reconcile: async () => ({ ...job }),
  });
  return { cancel, finishStop: () => { job.status = "cancelled"; },
    start: () => { if (job.status === "queued") { launchCount += 1; job.status = "running"; } },
    counts: () => ({ launchCount, stopRequests }) };
}

test("cancel before launch is terminal and prevents a task launch", async () => {
  const harness = cancellationHarness("queued");
  assert.deepEqual(await harness.cancel(), { jobId: "J1", status: "cancelled", terminal: true });
  harness.start();
  assert.deepEqual(harness.counts(), { launchCount: 0, stopRequests: 0 });
});

test("running cancellation stays nonterminal until confirmed stopped; repeated cancel is safe", async () => {
  const harness = cancellationHarness("running");
  assert.deepEqual(await harness.cancel(), { jobId: "J1", status: "cancelling", terminal: false });
  assert.deepEqual(await harness.cancel(), { jobId: "J1", status: "cancelling", terminal: false });
  assert.deepEqual(harness.counts(), { launchCount: 0, stopRequests: 1 });
  harness.finishStop();
  assert.deepEqual(await harness.cancel(), { jobId: "J1", status: "cancelled", terminal: true });
});

test("cancellation during task startup remains pending until launch or absence is reconciled", async () => {
  const harness = cancellationHarness("starting");
  assert.deepEqual(await harness.cancel(), { jobId: "J1", status: "cancelling", terminal: false });
  assert.equal(harness.counts().stopRequests, 1);
});

test("cancel of a terminal job returns its current outcome without requesting stop", async () => {
  const harness = cancellationHarness("completed");
  assert.deepEqual(await harness.cancel(), { jobId: "J1", status: "completed", terminal: true });
  assert.equal(harness.counts().stopRequests, 0);
});
