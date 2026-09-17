import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { authenticateMedRevenueAvaility } from '../medrevenue/authentication';
import type { JobEvent, LogEvent } from '../../../../types';
import { generateAvailityEligibilityTotp } from '../totp';

test('MedRevenue Secret Key generates the code automatically without a frontend OTP request', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  // Synthetic Google Authenticator export, matching the existing Minimax format.
  const account = Buffer.concat([Buffer.from([10, 20]), Buffer.from('12345678901234567890'), Buffer.from([32, 1, 40, 1, 48, 2])]);
  const secret = Buffer.concat([Buffer.from([10, account.length]), account]).toString('base64');
  try {
    const page = await browser.newPage();
    let verified = false;
    await page.route('https://availity.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/verify') {
        assert.equal(url.searchParams.get('code'), generateAvailityEligibilityTotp(secret));
        verified = true;
        return route.fulfill({ contentType: 'text/html', body: '<div id="patient_registration-menu">Patient Registration</div>' });
      }
      return route.fulfill({ contentType: 'text/html', body: `
        <input id="userId" name="userId"><input id="password" name="password" type="password">
        <button onclick="document.querySelector('#mfa').hidden=false">Sign In</button>
        <form id="mfa" hidden action="/verify"><input id="code" name="code"><button>Continue</button></form>` });
    });
    const events: JobEvent[] = [], logs: LogEvent[] = [];
    await authenticateMedRevenueAvaility(page, {
      loginUrl: 'https://availity.test/login', username: 'test-user', password: 'test-password',
      totpSecret: secret, successUrlFragment: '/verify',
    }, {
      jobId: 'test-job', projectId: 'medrevenue', portalId: 'availity', workflowId: 'eligibility-verification',
      log: async event => { logs.push(event); }, emit: async event => { events.push(event); },
    }, async () => { throw new Error('Automatic authentication must not request frontend input.'); });
    assert.equal(verified, true);
    assert.equal(events.some(event => event.type === 'otp_request'), false);
    assert.ok(logs.some(event => event.eventName === 'eligibility_availity_automatic_authentication'));
    assert.ok(!JSON.stringify(logs).includes(secret));
  } finally { await browser.close(); }
});
