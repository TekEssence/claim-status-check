import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { authenticationErrorCodes, loginDestination, startHealthNetLoginDiagnostics } from './login-diagnostics';

test('authentication error capture retains only known codes', () => {
  assert.deepEqual(authenticationErrorCodes('{"code":"INVALID_SESSION","message":"email@example.com secret-token 123456"}'), ['INVALID_SESSION']);
  assert.deepEqual(authenticationErrorCodes('private information without a recognized code'), []);
});

test('login destinations omit SSO tokens, credentials and query strings', () => {
  const destination = loginDestination('https://user:password@sso.entrykeyid.com/as/secret-token/resume/as/authorization.ping?state=secret-state&error=access_denied');
  assert.deepEqual(destination, { host: 'sso.entrykeyid.com', stage: 'sso-resume', authenticationDenied: true });
  assert.equal(JSON.stringify(destination).includes('secret'), false);
});

test('login diagnostics capture HTTP errors and stop recording before eligibility', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://auth.test/**', route => route.fulfill({ status: 400, contentType: 'text/html', body: '<input id="password" value="secret-password"><input autocomplete="one-time-code" value="123456">' }));
    const baseline = (page as unknown as { listenerCount(event: string): number }).listenerCount('response');
    const diagnostics = startHealthNetLoginDiagnostics(page);
    await page.goto('https://auth.test/secret-path?state=secret-state&error=access_denied');
    const emitted: Record<string, unknown>[] = [];
    await diagnostics.finish({ jobId: 'test', workflowId: 'eligibility-verification', portalId: 'healthnet', log: async () => {}, emit: async event => { emitted.push(event); } }, 'failure', new Error('secret-password'));
    assert.equal((page as unknown as { listenerCount(event: string): number }).listenerCount('response'), baseline);
    const download = emitted.find(event => event.type === 'file_download')!;
    const text = Buffer.from(String(download.base64), 'base64').toString();
    assert.doesNotMatch(text, /secret-|123456/);
    const report = JSON.parse(text);
    assert.ok(report.events.some((event: { status: number }) => event.status === 400));
    assert.equal(report.screens[0].controls.password, true);
    assert.ok(emitted.some(event => event.type === 'error_screenshot'));
  } finally { await browser.close(); }
});
