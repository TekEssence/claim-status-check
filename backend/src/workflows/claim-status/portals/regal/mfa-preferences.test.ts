import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { matchRegalPreference } from './mfa-preferences';
import { readRegalCredentialsFromBuffer } from './input';
import { prepareGenericClaimStatusServiceInput } from '../../../../aws/service/generic-claim-status-input';
import { openRegalPhoneCodeEntryIfPresent } from './login-job';
import { regalConfig } from './config';
import type { Page } from 'playwright-core';
import type { ScraperContext } from '../../types';

const options = [
  { value: 'phone_number__0', methodKey: 'phone_number', label: 'Phone', description: '+1 XXX-XXX-0053' },
  { value: 'phone_number__1', methodKey: 'phone_number', label: 'Phone', description: '+1 XXX-XXX-1144' },
  { value: 'okta_email__2', methodKey: 'okta_email', label: 'Email', description: 'masked@example.test' },
];

test('Regal uniquely matches a preferred full phone or suffix without selecting email', () => {
  for (const preferences of [{ preferredPhone: '+1 (555) 555-0053' }, { preferredPhoneSuffix: '0053' }, { preferredPhoneSuffix: '0053', verificationMethod: 'SMS' }]) {
    assert.equal(matchRegalPreference(options, preferences, 'authenticator').option?.value, 'phone_number__0');
  }
});

test('Regal email selection matches exact and masked addresses without selecting phone or other authenticators', () => {
  for (const address of ['alice@example.test', 'AL***@EXAMPLE.TEST', 'a*@example.test', 'a***e@e***.test', 'a\u2022\u2022\u2022e@example.test']) {
    const choices = [
      ...options,
      { value: 'matching-email', methodKey: 'okta_email', label: 'Email', description: address },
      { value: 'totp', methodKey: 'okta_verify-totp', label: 'Authenticator', description: address },
      { value: 'other-email', methodKey: 'okta_email', label: 'Email', description: 'b***@example.test' },
    ];
    const preferences = { preferredEmail: ' Alice@Example.Test ', verificationMethod: 'EMAIL', preferredPhoneSuffix: '0053' };
    assert.equal(matchRegalPreference(choices, preferences, 'authenticator').option?.value, 'matching-email');
    assert.equal(matchRegalPreference(choices, { preferredEmail: 'alice@example.test' }, 'authenticator').option?.value, 'matching-email');
  }
});

test('Regal masked email matching anchors visible characters and treats regex punctuation literally', () => {
  const choice = { value: 'email', methodKey: 'okta_email', label: 'Email', description: 'a+***@example.test' };
  assert.equal(matchRegalPreference([choice], { preferredEmail: 'a+smith@example.test', verificationMethod: 'email' }, 'authenticator').option?.value, 'email');
  for (const preferredEmail of ['axsmith@example.test', 'a+smith@other.test', 'a+smith@example.test.evil']) {
    assert.equal(matchRegalPreference([choice], { preferredEmail, verificationMethod: 'email' }, 'authenticator').option, undefined);
  }
});

test('Regal ambiguous, disabled, unreadable and invalid email matches fall back to manual selection without exposing addresses', () => {
  const email = { value: 'email', methodKey: 'okta_email', label: 'Email', description: 'a***@example.test' };
  for (const choices of [
    [email, { ...email, value: 'second-email' }],
    [{ ...email, disabled: true }],
    [{ ...email, description: '***@example.test' }],
    [{ ...email, description: 'b***@example.test' }],
    [{ ...email, description: 'a***@example.test or another@example.test' }],
    [{ ...email, description: '' }],
    options.filter(option => option.methodKey === 'phone_number'),
  ]) {
    const result = matchRegalPreference(choices, { preferredEmail: 'alice@example.test', verificationMethod: 'email' }, 'authenticator');
    assert.equal(result.option, undefined);
    assert.match(result.message!, /Select an option manually/);
    assert.doesNotMatch(result.message!, /alice|example\.test/);
  }
  for (const preferredEmail of ['', 'not-an-email', 'a***@example.test']) {
    assert.equal(matchRegalPreference([email], { preferredEmail, verificationMethod: 'email' }, 'authenticator').option, undefined);
  }
  assert.equal(matchRegalPreference([email, ...options], { preferredEmail: 'alice@example.test', preferredPhoneSuffix: '0053' }, 'authenticator').option, undefined);
  assert.equal(matchRegalPreference([email, ...options], { preferredEmail: 'alice@example.test', preferredPhoneSuffix: '0053', verificationMethod: 'call' }, 'authenticator').option?.value, 'phone_number__0');
});

test('Regal missing, ambiguous, unmatched and invalid preferences require manual selection without leaking values', () => {
  assert.deepEqual(matchRegalPreference(options, {}, 'authenticator'), {});
  assert.match(matchRegalPreference([...options, options[0]], { preferredPhoneSuffix: '0053' }, 'authenticator').message!, /multiple/);
  const result = matchRegalPreference(options, { preferredPhoneSuffix: '9999' }, 'authenticator');
  assert.match(result.message!, /No available/);
  assert.ok(!JSON.stringify(result).includes('9999'));
  assert.equal(matchRegalPreference(options, { verificationMethod: 'invalid' }, 'authenticator').option, undefined);
});

test('Regal delivery matching selects SMS or call only when unique and enabled', () => {
  const delivery = [{ value: 'sms', label: 'Send SMS' }, { value: 'call', label: 'Voice call' }];
  assert.equal(matchRegalPreference(delivery, { verificationMethod: 'SMS' }, 'delivery').option?.value, 'sms');
  assert.equal(matchRegalPreference(delivery, { verificationMethod: 'call' }, 'delivery').option?.value, 'call');
  assert.equal(matchRegalPreference(delivery, {}, 'delivery').option, undefined);
  assert.equal(matchRegalPreference(delivery.map(option => ({ ...option, disabled: true })), { verificationMethod: 'sms' }, 'delivery').option, undefined);
});

test('Regal legacy login workbooks remain compatible', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Link: 'https://example.test', Username: 'dummy', Password: 'dummy' }]), 'Login');
  const parsed = readRegalCredentialsFromBuffer(XLSX.write(workbook, { type: 'array', bookType: 'xlsx' }));
  assert.equal(parsed?.username, 'dummy');
  assert.equal(parsed?.preferredPhone, undefined);
  assert.equal(parsed?.preferredEmail, undefined);
  assert.equal(parsed?.verificationMethod, undefined);
});

test('Regal service preferences survive workbook generation and native credential parsing', async () => {
  const prepared = await prepareGenericClaimStatusServiceInput('regal', {
    credentials: { login_url: 'https://example.test', username: 'dummy', password: 'dummy', preferred_phone: '+15555550053', preferred_phone_suffix: '0053', verification_method: 'call' },
    claims: [{ client_row_ref: 'claim-1', data: { Group: 'IUMG', 'Member Name': 'Test, Person', DOS: '08/25/2026' } }],
  });
  const file = prepared.files.find(file => file.field === 'loginExcel')!;
  const parsed = readRegalCredentialsFromBuffer(Uint8Array.from(file.buffer).buffer);
  assert.equal(parsed?.preferredPhone, '+15555550053');
  assert.equal(parsed?.preferredPhoneSuffix, '0053');
  assert.equal(parsed?.verificationMethod, 'call');
});

test('Regal service email preferences reach the native reader and the existing MFA matcher', async () => {
  const prepared = await prepareGenericClaimStatusServiceInput('regal', {
    credentials: { login_url: 'https://example.test', username: 'dummy', password: 'dummy', preferred_email: 'alice@example.test', verification_method: 'email' },
    claims: [{ client_row_ref: 'claim-1', data: { Group: 'IUMG', 'Member Name': 'Test, Person', DOS: '08/25/2026' } }],
  });
  const file = prepared.files.find(file => file.field === 'loginExcel')!;
  const book = XLSX.read(file.buffer, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets[book.SheetNames[0]]);
  assert.equal(rows[0]['Preferred Email'], 'alice@example.test');
  assert.equal(rows[0]['Verification Method'], 'email');
  const parsed = readRegalCredentialsFromBuffer(Uint8Array.from(file.buffer).buffer)!;
  assert.equal(parsed.preferredEmail, 'alice@example.test');
  assert.equal(parsed.verificationMethod, 'email');
  assert.equal(matchRegalPreference([{ value: 'email', methodKey: 'okta_email', label: 'Email', description: 'a***@example.test' }], parsed, 'authenticator').option?.value, 'email');
});

for (const columns of [
  { 'Preferred Email': 'alice@example.test', 'Verification Method': 'email' },
  { preferred_email: 'alice@example.test', verification_method: 'EMAIL' },
]) {
  test(`Regal login Excel supports ${Object.keys(columns).join(' / ')}`, () => {
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet([{ Link: 'https://example.test', Username: 'dummy', Password: 'dummy', ...columns }]), 'Login');
    const parsed = readRegalCredentialsFromBuffer(XLSX.write(book, { type: 'array', bookType: 'xlsx' }));
    assert.equal(parsed?.preferredEmail, 'alice@example.test');
    assert.equal(parsed?.verificationMethod?.toLowerCase(), 'email');
  });
}

for (const variant of ['radio', 'buttons']) {
  test(`Regal phone page selects the requested call method using ${variant} before requesting the runtime OTP`, async () => {
    let codeVisible = false;
    let selected = '';
    const logs: string[] = [];
    const events: unknown[] = [];
    const control = (label: string) => ({
      isVisible: async () => true, isEnabled: async () => true,
      evaluate: async () => label,
      check: async () => { selected = label; },
      click: async () => { if (variant === 'buttons') selected = label; codeVisible = true; },
      waitFor: async () => {},
    });
    const collection = (items: ReturnType<typeof control>[]) => ({ count: async () => items.length, nth: (index: number) => items[index], first: () => items[0] });
    const buttons = collection((variant === 'buttons' ? ['Send SMS', 'Call me'] : ['Send code']).map(control));
    const page = {
      locator: (selector: string) => {
        if (selector === regalConfig.selectors.phoneSendSubmit) return buttons;
        if (selector === 'input[type="radio"]') return collection(variant === 'radio' ? ['SMS', 'Voice call'].map(control) : []);
        if (selector === regalConfig.selectors.googleAuthenticatorCode) return { first: () => ({ isVisible: async () => codeVisible }) };
        return { first: () => control('Verify') };
      },
      waitForLoadState: async () => {},
    } as unknown as Page;
    const context = { emit: async (event: unknown) => { events.push(event); } } as unknown as ScraperContext;
    assert.equal(await openRegalPhoneCodeEntryIfPresent(page, async (_level, _stage, message) => { logs.push(message); }, context, { verificationMethod: 'call', preferredPhone: '+15555550053' }), true);
    assert.match(selected, /call/i);
    assert.deepEqual(events, []);
    assert.ok(!JSON.stringify(logs).includes('5555550053'));
  });
}
