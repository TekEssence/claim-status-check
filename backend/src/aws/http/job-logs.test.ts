import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { GetLogEventsCommand, CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { listCloudWatchJobLogs } from "./jobs";
import { getPool, resetDbPool } from "@/db";
import { appendWorkflowEvent, listWorkflowEvents } from "../runtime/workflow-db";
import * as workflowDb from "../runtime/workflow-db";
import * as finalizer from "../service/service-cancellation-finalizer";

test("job logs read the newest 200 directly from the task stream and display in chronological order", async () => {
  const previousGroup = process.env.WORKER_LOG_GROUP;
  const previousContainer = process.env.WORKER_CONTAINER_NAME;
  process.env.WORKER_LOG_GROUP = "/claim-status/test/worker";
  process.env.WORKER_CONTAINER_NAME = "worker";
  let requests = 0;
  const client = { async send(command: GetLogEventsCommand) {
    requests += 1;
    assert.deepEqual(command.input, { logGroupName: "/claim-status/test/worker",
      logStreamName: "/service/worker/task-123", limit: 200, startFromHead: false });
    return { events: [
      { timestamp: 30, message: JSON.stringify({ jobId: "job-A", message: "Last message" }) },
      { timestamp: 10, message: "\u001b[32mLogging in\u001b[0m" },
      { timestamp: 20, message: JSON.stringify({ message: "Searching" }) },
      { timestamp: 40, message: JSON.stringify({ jobId: "other-job", message: "Do not show" }) },
    ] };
  } } as unknown as Pick<CloudWatchLogsClient, "send">;
  try {
    assert.deepEqual(await listCloudWatchJobLogs({ jobId: "job-A", ecsTaskArn: "arn:aws:ecs:region:account:task/cluster/task-123" }, client),
      ["Logging in", "Searching", "Last message"]);
    assert.equal(requests, 1);
    assert.deepEqual(await listCloudWatchJobLogs({ jobId: "job-A", ecsTaskArn: null }, client), []);
    assert.equal(requests, 1);
  } finally {
    if (previousGroup === undefined) delete process.env.WORKER_LOG_GROUP; else process.env.WORKER_LOG_GROUP = previousGroup;
    if (previousContainer === undefined) delete process.env.WORKER_CONTAINER_NAME; else process.env.WORKER_CONTAINER_NAME = previousContainer;
  }
});

test("ordinary logs/progress make no event inserts; event polling reads input requests/acknowledgements only", async () => {
  for (const type of ["log", "warning", "error", "progress", "row_progress"]) {
    assert.equal(await appendWorkflowEvent("job-A", type, { type }), null);
  }
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://fixture:fixture@localhost/fixture";
  const pool = getPool(), original = pool.query;
  let query = "", parameters: unknown[] = [];
  pool.query = (async (config: { text: string }, values: unknown[]) => {
    query = config.text; parameters = values; return { rows: [] };
  }) as typeof pool.query;
  try {
    assert.deepEqual(await listWorkflowEvents("job-A", 12), []);
    assert.match(query, /event_type.*in/);
    assert.deepEqual(parameters, ["job-A", 12, "input_request", "input_submitted", "input_consumed", 500]);
  } finally {
    pool.query = original;
    await resetDbPool();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
  }
});

test("AR Outputs lists a legacy cancelled job without running recovery or blocking other files", async () => {
  const jobsPath = require.resolve("./jobs");
  const cached = require.cache[jobsPath];
  const loader = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
  const originalLoad = loader._load;
  let recoveries = 0;
  const jobs = [
    { jobId: "old-cancelled", userId: "service:AR_WORKFLOW", clientSystem: "AR_WORKFLOW", workflowId: "claim-status", portalId: "optum-pro", status: "cancelled", currentCompleted: 22, totalRows: 359, metadata: { expectedRowCount: 359 }, finishedAt: "2026-11-12T07:39:58Z" },
    { jobId: "valid-completed", userId: "service:AR_WORKFLOW", clientSystem: "AR_WORKFLOW", workflowId: "claim-status", portalId: "aerial", status: "completed", currentCompleted: 1, totalRows: 1, metadata: {} },
  ];
  delete require.cache[jobsPath];
  loader._load = function (request, parent, isMain) {
    if (parent?.filename === jobsPath && request === "../runtime/workflow-db") return {
      ...workflowDb,
      listArWorkflowOutputJobs: async () => jobs,
      listRecentOutputArtifactsForJob: async (jobId: string) => [{ id: 1, artifactType: "output_snapshot", filename: `${jobId}.xlsx`, bucket: "outputs", s3Key: `${jobId}/output.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", createdAt: "2026-11-12T07:39:58Z" }],
    };
    if (parent?.filename === jobsPath && request === "../service/service-cancellation-finalizer") return {
      ...finalizer,
      finalizeCancelledServiceJob: async () => { recoveries++; throw new Error("Previously recorded results contain unfinished worker rows."); },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const isolated = require("./jobs") as typeof import("./jobs");
    const response = await isolated.listJobs({ queryStringParameters: { scope: "ar-workflow-outputs", limit: "50" }, requestContext: { authorizer: { jwt: { claims: { sub: "admin", "cognito:groups": '["ADMIN"]' } } } } });
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.deepEqual(body.jobs.map((job: { jobId: string }) => job.jobId), ["old-cancelled", "valid-completed"]);
    assert.equal(body.jobs[0].artifacts[0].filename, "old-cancelled.xlsx");
    assert.equal(body.jobs[1].artifacts[0].filename, "valid-completed.xlsx");
    assert.equal(recoveries, 0);
  } finally {
    loader._load = originalLoad;
    if (cached) require.cache[jobsPath] = cached; else delete require.cache[jobsPath];
  }
});

test("job polling reads saved progress/input state without recovery; CloudWatch is explicitly requested", async (t) => {
  const jobsPath = require.resolve("./jobs"), cached = require.cache[jobsPath];
  const loader = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
  const originalLoad = loader._load;
  const previousGroup = process.env.WORKER_LOG_GROUP;
  process.env.WORKER_LOG_GROUP = "/claim-status/test/worker";
  let recoveries = 0, logRequests = 0;
  const job = { jobId: "job", status: "cancelled", clientSystem: "AR_WORKFLOW", workflowId: "claim-status", portalId: "optum-pro", currentCompleted: 22, totalRows: 359, metadata: { expectedRowCount: 359 }, ecsTaskArn: "arn:aws:ecs:region:account:task/cluster/task", finishedAt: "2026-11-12T07:39:58Z" };
  const input = { id: 1, payload: { type: "input_request", inputName: "otp" } };
  t.mock.method(CloudWatchLogsClient.prototype, "send", async () => {
    logRequests++;
    return { events: [{ timestamp: 1, message: "Saved history" }] };
  });
  delete require.cache[jobsPath];
  loader._load = function (request, parent, isMain) {
    if (parent?.filename === jobsPath && request === "../runtime/workflow-db") return {
      ...workflowDb,
      getWorkflowJobForUser: async (_id: string, userId: string) => userId === "owner" ? job : null,
      listWorkflowEvents: async () => [input], listArtifactsForJob: async () => [],
    };
    if (parent?.filename === jobsPath && request === "../service/service-cancellation-finalizer") return {
      ...finalizer, finalizeCancelledServiceJob: async () => { recoveries++; throw new Error("Recovery must not run during polling."); },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const isolated = require("./jobs") as typeof import("./jobs");
    const request = { pathParameters: { jobId: "job" }, requestContext: { authorizer: { jwt: { claims: { sub: "owner" } } } } };
    const response = await isolated.getJob(request);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body).events, [input]);
    assert.equal(JSON.parse(response.body).job.currentCompleted, 22);
    assert.equal(JSON.parse(response.body).logs, undefined);
    assert.equal(logRequests, 0);
    const history = await isolated.getJob({ ...request, queryStringParameters: { includeLogs: "true" } });
    assert.deepEqual(JSON.parse(history.body).logs, ["Saved history"]);
    assert.equal(logRequests, 1);
    assert.equal(recoveries, 0);
    assert.equal((await isolated.getJob({ ...request, requestContext: { authorizer: { jwt: { claims: { sub: "other-user" } } } } })).statusCode, 404);
  } finally {
    loader._load = originalLoad;
    if (cached) require.cache[jobsPath] = cached; else delete require.cache[jobsPath];
    if (previousGroup === undefined) delete process.env.WORKER_LOG_GROUP; else process.env.WORKER_LOG_GROUP = previousGroup;
  }
});
