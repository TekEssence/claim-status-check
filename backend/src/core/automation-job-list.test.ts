import test from 'node:test';
import assert from 'node:assert/strict';
import { getPool, resetDbPool } from '@/db';
import { appendAutomationJobArtifact, getAutomationJobForUser, listAutomationJobSummariesForUser } from '@/lib/automation-jobs/db';
import { appendScrapeJobArtifact, getScrapeJobByIdForUser } from '@/lib/scrape-jobs/db';
import { expandLocalArtifacts, listLocalArtifactFiles } from '@/lib/automation-jobs/artifacts';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ArtifactManifest } from '@/backend/src/aws/runtime/artifact-manifest';
import { getTableColumns } from 'drizzle-orm';
import { automationJobs } from '@/db/schema/automation-jobs';
import { createScrapeJob, emitScrapeJobEvent, subscribeToScrapeJob, type ScrapeJobEvent } from '@/backend/src/jobs/job-store';

test('job list uses one summary query without loading logs or artifact payloads', async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://fixture:fixture@localhost/fixture';
  const pool = getPool();
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const original = pool.query;
  pool.query = (async (config: { text: string }, values: unknown[]) => {
    queries.push({ text: config.text, values });
    return { rows: [] };
  }) as typeof pool.query;
  try {
    assert.deepEqual(await listAutomationJobSummariesForUser('owner-id', 25), []);
    assert.equal(queries.length, 1);
    assert.doesNotMatch(queries[0].text, /automation_job_logs|metadata_json|path_or_key/);
    assert.match(queries[0].text, /count\(\*\)/);
    assert.match(queries[0].text, /"automation_jobs"\."user_id" = \$1/);
    assert.deepEqual(queries[0].values, ['owner-id', 25]);
    await listAutomationJobSummariesForUser('other-owner', 1000);
    assert.deepEqual(queries[1].values, ['other-owner', 100]);
    await listAutomationJobSummariesForUser('owner-id', NaN);
    assert.deepEqual(queries[2].values, ['owner-id', 25]);
  } finally {
    pool.query = original;
    await resetDbPool();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test('local job details work without the log table and still load artifacts', async () => {
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = 'postgres://fixture:fixture@localhost/fixture';
  const pool = getPool();
  const original = pool.query;
  const queries: string[] = [];
  const job = {
    jobId: 'local-job', userId: 'owner-id', workflowId: 'claim-status', portalId: 'iehp',
    status: 'running', currentCompleted: 1, totalItems: 3, metadataJson: {},
    primaryInputFileName: 'claims.xlsx', credentialFileName: 'login.xlsx',
    createdAt: '2026-11-17T00:00:00Z', updatedAt: '2026-11-17T00:00:00Z',
  };
  pool.query = (async (config: { text: string }) => {
    queries.push(config.text);
    assert.doesNotMatch(config.text, /automation_job_logs/);
    if (config.text.includes('from "automation_jobs"')) {
      return { rows: [Object.keys(getTableColumns(automationJobs)).map(key => job[key as keyof typeof job] ?? null)] };
    }
    assert.match(config.text, /automation_job_artifacts/);
    return { rows: [] };
  }) as typeof pool.query;
  try {
    for (const read of [getAutomationJobForUser, getScrapeJobByIdForUser]) {
      const details = await read('local-job', 'owner-id');
      assert.equal(details?.jobId, 'local-job');
      assert.deepEqual(details?.logs, []);
      assert.deepEqual(details?.artifacts, []);
    }
    assert.equal(queries.length, 4);
  } finally {
    pool.query = original;
    await resetDbPool();
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
});

test('local stream subscriptions replay buffered logs and receive new logs without database reads', () => {
  const job = createScrapeJob('local-sse-log-test');
  emitScrapeJobEvent(job.id, { type: 'log', message: 'Buffered in memory' });
  const events: ScrapeJobEvent[] = [];
  const unsubscribe = subscribeToScrapeJob(job.id, 0, event => events.push(event));
  try {
    assert.deepEqual(events.map(event => event.data.message), ['Buffered in memory']);
    emitScrapeJobEvent(job.id, { type: 'log', message: 'New live message' });
    assert.deepEqual(events.map(event => event.data.message), ['Buffered in memory', 'New live message']);
  } finally {
    unsubscribe();
  }
  assert.equal(job.subscribers.size, 0);
});

test('both local artifact writers upsert one job summary; folder downloads include only registered files', async () => {
  const previousUrl = process.env.DATABASE_URL;
  const previousBucket = process.env.WORKFLOW_OUTPUTS_BUCKET;
  process.env.DATABASE_URL = 'postgres://fixture:fixture@localhost/fixture';
  delete process.env.WORKFLOW_OUTPUTS_BUCKET;
  const directory = mkdtempSync(path.join(os.tmpdir(), 'local-artifact-test-'));
  const workbook = path.join(directory, 'claims.xlsx'), pdf = path.join(directory, 'claim.pdf');
  writeFileSync(workbook, 'workbook'); writeFileSync(pdf, 'pdf');
  writeFileSync(path.join(directory, 'another-job.pdf'), 'not registered');
  const pool = getPool(), originalConnect = pool.connect;
  let metadata: { artifactManifest: ArtifactManifest } | undefined;
  let inserts = 0;
  const client = { async query(query: string, values?: unknown[]) {
    if (query.startsWith('SELECT job_id')) return { rowCount: 1, rows: [{ job_id: 'local-job' }] };
    if (query.startsWith('SELECT metadata_json')) return { rows: metadata ? [{ metadata_json: structuredClone(metadata) }] : [] };
    if (query.startsWith('INSERT')) {
      assert.match(query, /ON CONFLICT\(job_id\) DO UPDATE/);
      metadata = JSON.parse(values![3] as string); inserts += 1;
    }
    return { rows: [] };
  }, release() {} };
  pool.connect = (async () => client) as typeof pool.connect;
  try {
    const input = { jobId: 'local-job', artifactType: 'output_snapshot', filename: 'claims.xlsx', pathOrKey: workbook };
    await appendScrapeJobArtifact(input);
    await appendAutomationJobArtifact(input);
    await appendScrapeJobArtifact({ ...input, artifactType: 'pdf_download', filename: 'claim.pdf', pathOrKey: pdf });
    const manifest = metadata!.artifactManifest;
    assert.equal(manifest.count, 2); assert.equal(manifest.revision, 3); assert.equal(inserts, 3);
    const files = await listLocalArtifactFiles('local-job', manifest);
    assert.deepEqual(files.map(file => file.filename).sort(), ['claim.pdf', 'claims.xlsx']);
    const expanded = expandLocalArtifacts({ id: 1, jobId: 'local-job', rowIndex: null, artifactType: 'artifact_folder',
      filename: 'local-job-artifacts.zip', mimeType: 'application/zip', pathOrKey: directory,
      metadataJson: { artifactManifest: manifest }, createdAt: '2026-11-17T00:00:00Z' });
    assert.deepEqual(expanded.map(file => file.artifactType), ['output_snapshot', 'artifact_folder']);
    unlinkSync(pdf);
    await assert.rejects(listLocalArtifactFiles('local-job', manifest), /missing/);
  } finally {
    pool.connect = originalConnect; await resetDbPool();
    if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl;
    if (previousBucket === undefined) delete process.env.WORKFLOW_OUTPUTS_BUCKET; else process.env.WORKFLOW_OUTPUTS_BUCKET = previousBucket;
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('local-artifact-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
});
