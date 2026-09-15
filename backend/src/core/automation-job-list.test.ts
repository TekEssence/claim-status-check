import test from 'node:test';
import assert from 'node:assert/strict';
import { getPool, resetDbPool } from '@/db';
import { listAutomationJobSummariesForUser } from '@/lib/automation-jobs/db';

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
