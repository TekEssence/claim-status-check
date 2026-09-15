import test from 'node:test';
import assert from 'node:assert/strict';
import { mediCalDnsArgs } from './dns';

const failedLookup = async () => { throw Object.assign(new Error('not found'), { code: 'ENOTFOUND' }); };
test('Medi-Cal DNS fallback is limited to official hosts and only used on lookup failure', async () => {
  let calls = 0;
  const dependencies = { lookup: failedLookup, resolve: async () => { calls++; return '54.186.230.3'; } };
  assert.deepEqual(await mediCalDnsArgs('https://another.test/', undefined, dependencies), []);
  assert.equal(calls, 0);
  assert.deepEqual(await mediCalDnsArgs('https://www.medi-cal.ca.gov/', undefined, { ...dependencies, lookup: async () => ({ address: '54.186.230.3', family: 4 }) }), []);
  assert.equal(calls, 0);
  const args = await mediCalDnsArgs('https://www.medi-cal.ca.gov/', undefined, dependencies);
  assert.equal(calls, 5);
  assert.match(args[0], /^--host-resolver-rules=MAP www\.medi-cal\.ca\.gov /);
  assert.ok(!args[0].includes('*'));
});
test('Medi-Cal DNS fallback rejects invalid addresses and reports resolver failures', async () => {
  await assert.rejects(mediCalDnsArgs('https://www.medi-cal.ca.gov/', undefined, { lookup: failedLookup, resolve: async () => 'invalid, MAP * attacker' }), /invalid address/);
  await assert.rejects(mediCalDnsArgs('https://www.medi-cal.ca.gov/', undefined, { lookup: failedLookup, resolve: async () => { throw new Error('offline'); } }), /system or secure DNS/);
});
