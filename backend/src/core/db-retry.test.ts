import test from 'node:test';
import assert from 'node:assert/strict';
import { isRetryableDbError } from '@/db';
import { isScrapeJobDbConnectionError } from '@/lib/scrape-jobs/db';

test('connection acquisition timeouts are retried and classified as unavailable through query wrappers', () => {
  const error = new Error('Failed query', { cause: new Error('timeout exceeded when trying to connect') });
  assert.equal(isRetryableDbError(error), true);
  assert.equal(isScrapeJobDbConnectionError(error), true);
  assert.equal(isRetryableDbError(new Error('invalid SQL')), false);
});
