import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { once } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { CloudWatchLogsClient, FilterLogEventsCommand } from "@aws-sdk/client-cloudwatch-logs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(root, "data", "exports");
const label = "2026-09-30_to_2026-10-05";
const start = new Date("2026-09-30T00:00:00+05:30");
const end = new Date("2026-10-06T00:00:00+05:30");
const mode = process.argv[2];

if (!new Set(["db", "logs"]).has(mode)) {
  console.error("Usage: node --env-file=.env.local scripts/export-claim-status-history.mjs [db|logs]");
  process.exit(2);
}

mkdirSync(outputDir, { recursive: true });

function csv(value) {
  const text = value == null ? "" : String(value);
  return `"${text.replaceAll('"', '""')}"`;
}

async function write(stream, text) {
  if (!stream.write(text)) await once(stream, "drain");
}

async function close(stream) {
  stream.end();
  await once(stream, "finish");
}

async function discard(stream, file) {
  stream.destroy();
  if (!stream.closed) await once(stream, "close");
  rmSync(file, { force: true });
}

const tables = [
  { name: "workflow_jobs", key: "job_id", updated: true, workflow: "workflow_id", portal: "portal_id" },
  { name: "workflow_job_events", key: "id" },
  { name: "workflow_job_commands", key: "id" },
  { name: "workflow_job_artifacts", key: "id" },
  { name: "automation_jobs", key: "job_id", updated: true, workflow: "workflow_id", portal: "portal_id" },
  { name: "automation_job_logs", key: "id" },
  { name: "automation_job_artifacts", key: "id" },
  { name: "iehp_scrape_jobs", key: "job_id", updated: true, portal: "portal_id" },
  { name: "iehp_scrape_job_logs", key: "id" },
  { name: "iehp_scrape_job_artifacts", key: "id" },
];

async function exportDb() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is missing. Load .env.local or set it in the shell.");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "false" ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();
  const file = path.join(outputDir, `claim-status-db-history-${label}.csv`);
  const partial = `${file}.partial`;
  const stream = createWriteStream(partial, { encoding: "utf8" });
  const counts = {};
  try {
    await write(stream, "source_table,job_id,workflow_id,portal_id,created_at,row_json\n");
    for (const table of tables) {
      let last = null;
      let count = 0;
      for (;;) {
        const condition = table.updated
          ? "((t.created_at >= $1 AND t.created_at < $2) OR (t.updated_at >= $1 AND t.updated_at < $2))"
          : "(t.created_at >= $1 AND t.created_at < $2)";
        const query = `SELECT t.${table.key} AS page_key, t.job_id, ${table.workflow ? `t.${table.workflow}` : "NULL::text"} AS workflow_id, ${table.portal ? `t.${table.portal}` : "NULL::text"} AS portal_id, t.created_at, row_to_json(t) AS row_json FROM ${table.name} t WHERE ${condition} AND ($3::${table.key === "id" ? "bigint" : "text"} IS NULL OR t.${table.key} > $3) ORDER BY t.${table.key} LIMIT 1000`;
        const result = await client.query(query, [start, end, last]);
        for (const row of result.rows) {
          await write(stream, [table.name, row.job_id, row.workflow_id, row.portal_id, row.created_at.toISOString(), JSON.stringify(row.row_json)].map(csv).join(",") + "\n");
        }
        count += result.rows.length;
        if (result.rows.length < 1000) break;
        last = result.rows.at(-1).page_key;
      }
      counts[table.name] = count;
    }
    await close(stream);
    renameSync(partial, file);
    console.log(JSON.stringify({ file, rows: counts }, null, 2));
  } catch (error) {
    await discard(stream, partial);
    throw error;
  } finally {
    await client.end();
  }
}

function deployedLogGroups() {
  const pulumiDir = path.join(root, ".sst", "pulumi");
  const logs = readdirSync(pulumiDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pulumiDir, entry.name, "eventlog.json"))
    .filter(existsSync);
  const latest = logs.map((file) => ({ file, modified: statSync(file).mtimeMs }))
    .sort((a, b) => b.modified - a.modified)[0]?.file;
  if (!latest) throw new Error("No local SST deployment event log found in .sst/pulumi.");
  const names = new Set();
  for (const line of readFileSync(latest, "utf8").split(/\r?\n/)) {
    if (!line.includes("resourcePreEvent")) continue;
    const metadata = JSON.parse(line).resourcePreEvent?.metadata;
    if (metadata?.type !== "aws:cloudwatch/logGroup:LogGroup") continue;
    for (const resource of [metadata.old, metadata.new]) {
      if (typeof resource?.outputs?.name === "string") names.add(resource.outputs.name);
    }
  }
  if (!names.size) throw new Error(`No CloudWatch log groups found in ${latest}`);
  return [...names].sort();
}

async function exportLogs() {
  const groups = deployedLogGroups();
  const client = new CloudWatchLogsClient({ region: process.env.AWS_REGION || "us-east-1" });
  const file = path.join(outputDir, `claim-status-cloudwatch-history-${label}.txt`);
  const partial = `${file}.partial`;
  const stream = createWriteStream(partial, { encoding: "utf8" });
  const counts = {};
  try {
    await write(stream, `CloudWatch logs; ${start.toISOString()} <= timestamp < ${end.toISOString()}\n`);
    for (const group of groups) {
      await write(stream, `\n=== ${group} ===\n`);
      let token;
      let count = 0;
      for (;;) {
        const result = await client.send(new FilterLogEventsCommand({
          logGroupName: group,
          startTime: start.getTime(),
          endTime: end.getTime(),
          nextToken: token,
        }));
        for (const event of result.events ?? []) {
          const timestamp = new Date(event.timestamp ?? 0).toISOString();
          await write(stream, `[${timestamp}] [${event.logStreamName ?? ""}]\n${event.message ?? ""}\n`);
        }
        count += result.events?.length ?? 0;
        if (!result.nextToken || result.nextToken === token) break;
        token = result.nextToken;
      }
      counts[group] = count;
    }
    await close(stream);
    renameSync(partial, file);
    console.log(JSON.stringify({ file, events: counts }, null, 2));
  } catch (error) {
    await discard(stream, partial);
    throw error;
  } finally {
    client.destroy();
  }
}

if (mode === "db") await exportDb();
else await exportLogs();
