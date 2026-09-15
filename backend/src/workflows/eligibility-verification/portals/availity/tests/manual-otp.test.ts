import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { authenticateMedRevenueAvaility } from '../medrevenue/authentication';
import type { JobEvent } from '../../../../types';

test('MedRevenue requests frontend OTP and verifies before returning; supports direct login', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const direct of [false, true]) {
      const page = await browser.newPage();
      await page.route('https://availity.test/**', route => route.fulfill({ contentType: 'text/html', body: `
        <input id=userId><input id=password type=password><button id=login>Sign In</button>
        <script>document.querySelector('#login').onclick=()=>{document.body.innerHTML=${JSON.stringify(direct ? '<div id="patient_registration-menu">Patient Registration</div>' : '<input id="code" name="code"><button id="verify">Continue</button>')};
        if(document.querySelector('#verify')) document.querySelector('#verify').onclick=()=>{if(document.querySelector('#code').value==='123456')document.body.innerHTML='<div id="patient_registration-menu">Patient Registration</div>'};};</script>` }));
      const events: JobEvent[] = [];
      let requests = 0;
      await authenticateMedRevenueAvaility(page, { loginUrl: 'https://availity.test/login', username: 'test', password: 'test', totpSecret: '', successUrlFragment: '' }, {
        jobId: 'test-job', workflowId: 'eligibility-verification', portalId: 'availity', projectId: 'medrevenue',
        log: async () => {}, emit: async event => { events.push(event); },
      }, async (jobId, inputName) => {
        assert.equal(jobId, 'test-job');
        assert.equal(events.at(-1)?.inputName, inputName);
        assert.equal(events.at(-1)?.type, 'otp_request');
        requests++;
        return requests === 1 ? 'bad-code' : '123456';
      });
      assert.equal(requests, direct ? 0 : 2);
      assert.ok(await page.locator('#patient_registration-menu').isVisible());
      assert.ok(!JSON.stringify(events).includes('123456'));
      await page.close();
    }
  } finally { await browser.close(); }
});
