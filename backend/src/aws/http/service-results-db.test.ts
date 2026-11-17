import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { publicationDatabase } from "../service/result-publication-test-helpers";
import * as store from "../service/result-publication-store";
import { summarizeServiceResults } from "../service/result-summary";
import type { ApiEvent } from "../runtime/http";
import type { getWorkflowJobById } from "../runtime/workflow-db";
import { ELIGIBILITY_SERVICE_PORTALS } from "../service/eligibility-portals";

test("ordinary Eligibility API polls read DB only and preserve authentication, ownership, cursors and OTP", async t => {
  const refs = ["A", "B", "C"];
  const db = publicationDatabase(refs);
  db.setJobState({ workflow_id: "eligibility-verification" });
  await store.publishServiceResultPage({ jobId: "job", expectedRefs: refs, cursor: 0, limit: 1,
    summary: summarizeServiceResults(["A", "C"].map(ref => ({ client_row_ref: ref, status: "SUCCESS" as const,
      result: { coverage_status: "active", details: { "Coverage Status": "active" } }, error_category: null, error_message: null }))),
    workerState: { finalized: false, artifact: null } }, db.pool);
  type Job = NonNullable<Awaited<ReturnType<typeof getWorkflowJobById>>>;
  let status: Job["status"] = "running";
  let owner = "AR_WORKFLOW";
  let workflow = "eligibility-verification";
  let portal = "availity";
  let s3Reads = 0; let reads = 0;
  const token = "read-only-results-test-token-at-least-32-characters";
  const previous = process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON;
  process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON = JSON.stringify({ AR_WORKFLOW: token });
  const loader = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
  const original = loader._load;
  loader._load = function(request, parent, isMain) {
    const name = request.replaceAll("\\", "/");
    if (/(^|\/)workflow-db(?:\.ts)?$/.test(name)) return {
      getWorkflowJobById: async () => ({ jobId: "job", workflowId: workflow, portalId: portal, clientSystem: owner,
        status, ecsTaskArn: "task", metadata: db.jobState().metadata, currentCompleted: 2, totalRows: 3,
        clientExecutionId: "execution", errorMessage: null } as Job),
      getLatestWorkflowInputRequest: async () => ({ createdAt: "2026-11-16T00:00:00Z", payload: { type: "otp_required", inputName: "otp", timeoutMs: 600000 } }),
    };
    if (/(^|\/)ecs(?:\.ts)?$/.test(name)) return { describeWorkerTask: async () => ({ lastStatus: "RUNNING" }) };
    if (/(^|\/)result-publication-store(?:\.ts)?$/.test(name)) return { ...store,
      readWorkerServiceResultPage: (id: string, cursor: number, limit: number) => { reads++; return store.readWorkerServiceResultPage(id, cursor, limit, db.pool); },
      publishServiceResultPage: () => { throw new Error("Ordinary polling must not publish results."); },
    };
    if (request === "@aws-sdk/client-s3") {
      const actual = original.call(this, request, parent, isMain) as object;
      return { ...actual, S3Client: class { send() { s3Reads++; throw new Error("Ordinary polling must not read S3."); } } };
    }
    return original.call(this, request, parent, isMain);
  };
  let api: typeof import("./service-jobs");
  try { api = await import("./service-jobs"); } finally { loader._load = original; }
  const event = (cursor = "0", limit = "1"): ApiEvent => ({ pathParameters: { jobId: "job" },
    headers: { "X-Client-System": "AR_WORKFLOW", Authorization: `Bearer ${token}` }, queryStringParameters: { cursor, limit } });
  const queryStart = db.queries.length;
  try {
    await t.test("cursor replay and later pages never read S3 or write publications", async () => {
      const first = await api.getServiceJobResult(event());
      assert.equal(first.statusCode, 200);
      const body = JSON.parse(first.body);
      assert.deepEqual([body.results[0].client_row_ref, body.next_cursor, body.final, body.processed, body.pending], ["A", "1", false, 2, 1]);
      assert.deepEqual(await api.getServiceJobResult(event()), first);
      const next = JSON.parse((await api.getServiceJobResult(event("1"))).body);
      assert.deepEqual([next.results[0].client_row_ref, next.next_cursor, next.final], ["C", "2", false]);
      assert.deepEqual(JSON.parse((await api.getServiceJobResult(event("2"))).body).results, []);
    });
    await t.test("authentication and ownership reject access before result reads", async () => {
      const before = reads;
      assert.equal((await api.getServiceJobResult({ ...event(), headers: {} })).statusCode, 401);
      owner = "OTHER";
      assert.equal((await api.getServiceJobResult(event())).statusCode, 404); owner = "AR_WORKFLOW";
      assert.equal(reads, before);
    });
    await t.test("every integrated Eligibility portal uses the same DB reader", async () => {
      for (portal of ELIGIBILITY_SERVICE_PORTALS) {
        const response = await api.getServiceJobResult(event());
        assert.equal(response.statusCode, 200);
        assert.deepEqual([JSON.parse(response.body).portal, JSON.parse(response.body).next_cursor], [portal, "1"]);
      }
      portal = "availity";
    });
    await t.test("page limits and OTP keep existing behavior", async () => {
      assert.equal((await api.getServiceJobResult(event("0", "201"))).statusCode, 400);
      status = "waiting_otp";
      const body = JSON.parse((await api.getServiceJobResult(event())).body);
      assert.equal(body.action_required.type, "OTP_REQUIRED"); assert.equal(body.status, "WAITING_OTP");
      assert.equal(body.action_required.expires_at, "2026-11-16T00:10:00.000Z");
    });
    await t.test("unintegrated workflows remain unsupported", async () => {
      workflow = "payment-posting";
      assert.equal((await api.getServiceJobResult(event())).statusCode, 422);
    });
    assert.equal(s3Reads, 0);
    assert.ok(db.queries.slice(queryStart).every(sql => sql.startsWith("SELECT")));
  } finally {
    if (previous === undefined) delete process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON;
    else process.env.CLAIM_STATUS_SERVICE_TOKENS_JSON = previous;
  }
});
