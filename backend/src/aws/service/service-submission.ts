import { createHash, createHmac, randomBytes, scryptSync } from "node:crypto";

export type ExistingServiceJob = {
  jobId: string;
  status: string;
  clientExecutionId: string | null;
  portalId: string;
  metadata: unknown;
};

export class ServiceSubmissionConflict extends Error {}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("Submission contains an unsupported value.");
  return encoded;
}

// The per-job salt and memory-hard digest let retries survive service token
// rotation while making offline guesses of a credential expensive.
export function serviceSubmissionFingerprint(body: unknown, salt: string): string {
  const payloadDigest = createHash("sha256").update(canonicalJson(body)).digest();
  return scryptSync(payloadDigest, Buffer.from(salt, "base64url"), 32, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("hex");
}

function tokenKeyedServiceSubmissionFingerprint(body: unknown, authenticatedToken: string): string {
  return createHmac("sha256", authenticatedToken).update(canonicalJson(body)).digest("hex");
}

// Pre-versioned jobs used this narrower fingerprint. Keep their retries
// readable without changing any existing database rows.
export function legacyServiceSubmissionFingerprint(body: Record<string, unknown>): string {
  const credentials = (body.credentials ?? {}) as Record<string, unknown>;
  return createHash("sha256").update(JSON.stringify({
    client_execution_id: body.client_execution_id,
    deadline_at: body.deadline_at,
    workflow: body.workflow,
    portal: body.portal,
    projectId: body.projectId,
    claims: body.claims,
    credential_identity: {
      login_url: credentials.login_url,
      username: credentials.username,
      claim_status_url: credentials.claim_status_url,
      success_url_fragment: credentials.success_url_fragment,
    },
  })).digest("hex");
}

function sameSubmission(job: ExistingServiceJob, params: {
  clientExecutionId: string;
  portalId: string;
  body: Record<string, unknown>;
  authenticatedToken: string;
}): boolean {
  const metadata = job.metadata as { requestHash?: unknown; requestHashVersion?: unknown; requestHashSalt?: unknown } | null;
  if (job.clientExecutionId !== params.clientExecutionId || job.portalId !== params.portalId) return false;
  let expected: string;
  if (metadata?.requestHashVersion === 3) {
    if (typeof metadata.requestHashSalt !== "string" || !metadata.requestHashSalt) {
      throw new Error("Stored service submission fingerprint salt is unavailable.");
    }
    expected = serviceSubmissionFingerprint(params.body, metadata.requestHashSalt);
  } else if (metadata?.requestHashVersion === 2) {
    expected = tokenKeyedServiceSubmissionFingerprint(params.body, params.authenticatedToken);
  } else {
    expected = legacyServiceSubmissionFingerprint(params.body);
  }
  return metadata?.requestHash === expected;
}

export async function reserveServiceSubmission<TPrepared, TJob extends ExistingServiceJob>(params: {
  clientSystem: string;
  clientExecutionId: string;
  idempotencyKey: string;
  portalId: string;
  body: Record<string, unknown>;
  authenticatedToken: string;
  find: (clientSystem: string, idempotencyKey: string) => Promise<TJob | null>;
  prepare: () => Promise<TPrepared>;
  createJobId: () => string;
  create: (jobId: string, prepared: TPrepared, fingerprint: string, salt: string) => Promise<void>;
  isUniqueViolation: (error: unknown) => boolean;
}): Promise<{ existing: true; job: TJob } | { existing: false; jobId: string; prepared: TPrepared }> {
  const identity = { clientExecutionId: params.clientExecutionId, portalId: params.portalId,
    body: params.body, authenticatedToken: params.authenticatedToken };
  const existing = await params.find(params.clientSystem, params.idempotencyKey);
  if (existing) {
    if (!sameSubmission(existing, identity)) throw new ServiceSubmissionConflict("Idempotency key was already used for a different execution or claim payload.");
    return { existing: true, job: existing };
  }

  const prepared = await params.prepare();
  const jobId = params.createJobId();
  const salt = randomBytes(16).toString("base64url");
  const fingerprint = serviceSubmissionFingerprint(params.body, salt);
  try {
    await params.create(jobId, prepared, fingerprint, salt);
  } catch (error) {
    if (!params.isUniqueViolation(error)) throw error;
    const winner = await params.find(params.clientSystem, params.idempotencyKey);
    if (!winner) throw error;
    if (!sameSubmission(winner, identity)) throw new ServiceSubmissionConflict("Idempotency key was already used for a different execution or claim payload.");
    return { existing: true, job: winner };
  }
  return { existing: false, jobId, prepared };
}

export async function lookupServiceSubmission<TJob extends ExistingServiceJob>(params: {
  clientSystem: string;
  clientExecutionId: string;
  idempotencyKey: string;
  find: (clientSystem: string, idempotencyKey: string) => Promise<TJob | null>;
}): Promise<{ found: false } | { found: true; job: TJob }> {
  const job = await params.find(params.clientSystem, params.idempotencyKey);
  if (!job) return { found: false };
  if (job.clientExecutionId !== params.clientExecutionId) {
    throw new ServiceSubmissionConflict("Idempotency key belongs to a different execution.");
  }
  return { found: true, job };
}
