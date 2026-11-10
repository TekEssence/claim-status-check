import test from 'node:test';
import assert from 'node:assert/strict';
import { submissionValidationLog } from './submission-validation-log';

test('validation logs identify the execution, claim count and failing row/field', () => {
  const log = submissionValidationLog(new Error('Claim 417 Service Date must use MM/DD/YYYY.'), {
    workflow: 'CLAIM_STATUS', portal: 'availity', claims: Array(1310).fill({}),
  }, 'AR_WORKFLOW', 'execution-123');
  assert.equal(log.statusCode, 422);
  assert.equal(log.client_execution_id, 'execution-123');
  assert.equal(log.claim_count, 1310);
  assert.equal(log.reason, 'Claim 417 Service Date must use MM/DD/YYYY.');
});

test('validation logs omit credentials, quoted input values, duplicate refs and stacks', () => {
  const body = { credentials: { password: 'secret-password', accounts: [{ username: 'private-account', totp_secret: 'secret-totp' }] }, claims: [{ data: { 'Member ID': 'private-member' } }] };
  const log = submissionValidationLog(new Error('Invalid "private-member" secret-password private-account secret-totp'), body, 'AR_WORKFLOW', 'execution-123');
  const serialized = JSON.stringify(log);
  for (const secret of ['private-member', 'secret-password', 'private-account', 'secret-totp', 'stack', 'credentials']) assert.ok(!serialized.includes(secret));
  assert.equal(submissionValidationLog(new Error('Duplicate client_row_ref: private-ref.'), body, 'AR_WORKFLOW', 'execution-123').reason, 'Duplicate client_row_ref: [redacted].');
});

test('credential field names remain clear and non-Error failures have a safe fallback', () => {
  assert.equal(submissionValidationLog(new Error('credentials.totp_secret must be a non-empty string.'), {}, 'AR_WORKFLOW', 'execution-123').reason, 'credentials.totp_secret must be a non-empty string.');
  assert.equal(submissionValidationLog({ password: 'secret' }, {}, 'AR_WORKFLOW', 'execution-123').reason, 'Invalid portal claim input.');
});
