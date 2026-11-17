import test from "node:test";
import assert from "node:assert/strict";
import { GetLogEventsCommand, type CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { listCloudWatchJobLogs } from "./jobs";
import { getPool, resetDbPool } from "@/db";
import { appendWorkflowEvent, listWorkflowEvents } from "../runtime/workflow-db";

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
