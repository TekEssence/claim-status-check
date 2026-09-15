import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright-core';
import { createHealthNetEligibilityRunner } from './scraper';
import { readHealthNetInput, readHealthNetCredentials, buildHealthNetOutput } from './data';
import { extractHealthNetResult, loginHealthNet, recoverHealthNetLogin, verifyHealthNetRow, waitForHealthNetLoginScreen, selectHealthNetTextMessage } from './portal';
import { getEligibilityPortalsForProject } from '@/frontend/src/workflows/eligibility-verification/registry';
import { createScrapeJob, submitScrapeJobInput } from '@/backend/src/jobs/job-store';

async function file(rows: unknown[][]) {
  const wb = new ExcelJS.Workbook(); wb.addWorksheet('Input').addRows(rows);
  return new File([new Uint8Array(await wb.xlsx.writeBuffer())], 'input.xlsx');
}

const response = `<div class="alert alert-success big">This patient is eligible as of today, Sep 10, 2026</div>
  <h3>Patient Information</h3><div><h4 class="title">Name</h4><p>Jane Doe</p></div><div><h4 class="title">Member #</h4><p>00123</p></div>
  <h3>PPG Information</h3><div><h4 class="title">Name</h4><p>Example PPG</p></div>
  <h3>Eligibility History</h3><table><thead><tr><th>Start Date</th><th>End Date</th><th id="elig_hist_productname">Product Name</th></tr></thead>
  <tbody><tr><td>01/01/2026</td><td></td><td>HMO</td></tr><tr><td>01/01/2025</td><td>12/31/2025</td><td>PPO</td></tr></tbody></table>`;

test('Health Net waits beyond the default timeout and explains authentication redirects', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const logs: string[] = [];
    const context = { jobId: 'fixture', workflowId: 'eligibility-verification' as const, portalId: 'healthnet', emit: async () => {}, log: async (event: { message: string }) => { logs.push(event.message); } };
    await page.setContent('<div id="next"></div>');
    page.setDefaultTimeout(50);
    await page.evaluate(() => { setTimeout(() => { document.querySelector('#next')!.textContent = 'Text Message: ***-***-9999'; }, 250); });
    await waitForHealthNetLoginScreen(page, page.getByText(/^Text Message:/), context, 'Text Message screen', 2000);
    assert.ok(logs.some(message => message.includes('Waiting for Health Net')));
    await page.route('https://healthnet.test/**', route => route.fulfill({ body: 'Authentication failed' }));
    await page.goto('https://healthnet.test/callback?error=access_denied&error_description=Authentication+failed', { timeout: 5000 });
    await assert.rejects(waitForHealthNetLoginScreen(page, page.locator('#missing'), context, 'Text Message screen', 100), /Authentication failed \/ access_denied/);
    assert.equal((page as unknown as { listenerCount(event: string): number }).listenerCount('framenavigated'), 0);
  } finally { await browser.close(); }
});

test('Health Net recognizes delayed SMS radio options without Material UI classes and switches from email', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<div style="height:1600px">Loading authentication</div><div id="mfa" hidden>
      <label><input type="radio" name="method" id="email" checked>E-Mail: masked</label>
      <label for="sms">Text Message: ***-***-0273</label><input type="radio" name="method" id="sms">
      <button onclick="document.body.dataset.sent=document.querySelector('#sms').checked?'sms':'email'">Send Code</button></div>`);
    await page.evaluate(() => { setTimeout(() => { (document.querySelector('#mfa') as HTMLElement).hidden = false; }, 250); });
    await selectHealthNetTextMessage(page, { jobId: 'fixture', workflowId: 'eligibility-verification', portalId: 'healthnet', emit: async () => {}, log: async () => {} });
    assert.equal(await page.locator('#sms').isChecked(), true);
    assert.equal(await page.locator('#email').isChecked(), false);
    assert.equal(await page.locator('body').getAttribute('data-sent'), 'sms');
    await page.setContent('<label><input type="radio">Text Message: 1111</label><label><input type="radio">Text Message: 2222</label>');
    await assert.rejects(selectHealthNetTextMessage(page, { jobId: 'fixture', workflowId: 'eligibility-verification', portalId: 'healthnet', emit: async () => {}, log: async () => {} }), /multiple Text Message recipients/);
  } finally { await browser.close(); }
});

test('Health Net manual recovery keeps the session open and waits without entering credentials', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://healthnet.test/login', route => route.fulfill({ contentType: 'text/html', body: '<input id="username"><input id="password" type="password"><div id="result"></div>' }));
    await page.context().addCookies([
      { name: 'failed-sso', value: 'fixture', domain: '.entrykeyid.com', path: '/' },
      { name: 'failed-portal', value: 'fixture', domain: 'provider.healthnetcalifornia.com', path: '/' },
      { name: 'unrelated', value: 'fixture', domain: 'unrelated.test', path: '/' },
    ]);
    const messages: string[] = [];
    const recovery = recoverHealthNetLogin(page, 'https://healthnet.test/login', { jobId: 'test', workflowId: 'eligibility-verification', portalId: 'healthnet', log: async event => { messages.push(event.message); }, emit: async () => {} }, 10_000);
    await page.locator('#password').waitFor();
    assert.deepEqual((await page.context().cookies()).map(cookie => cookie.name), ['unrelated']);
    assert.equal(await page.locator('#username').inputValue(), '');
    assert.equal(await page.locator('#password').inputValue(), '');
    await page.evaluate(() => { document.querySelector('#result')!.innerHTML = '<input name="memberIdOrLastName">'; });
    assert.equal(await recovery, 'https://healthnet.test/login');
    assert.equal(page.isClosed(), false);
    assert.ok(messages.some(message => message.includes('Enter your username and password in the bot browser')));
    await assert.rejects(recoverHealthNetLogin(page, page.url(), { jobId: 'test', workflowId: 'eligibility-verification', portalId: 'healthnet', log: async () => {}, emit: async () => {}, isCancelled: () => true }), /cancelled/);
  } finally { await browser.close(); }
});

test('Health Net manual recovery survives an aborted login navigation', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://healthnet.test/login', route => route.abort('aborted'));
    let notice!: () => void;
    const notified = new Promise<void>(resolve => { notice = resolve; });
    const recovery = recoverHealthNetLogin(page, 'https://healthnet.test/login', { jobId: 'test', workflowId: 'eligibility-verification', portalId: 'healthnet', emit: async () => {}, log: async event => {
      if (event.eventName === 'eligibility_healthnet_recovery_navigation') notice();
    } }, 10_000);
    await notified;
    assert.equal(page.isClosed(), false);
    await page.setContent('<input name="memberIdOrLastName">');
    await recovery;
    assert.equal(page.isClosed(), false);
  } finally { await browser.close(); }
});

test('Health Net routing, credentials and input are isolated to MedRevenu', async () => {
  assert.equal(getEligibilityPortalsForProject('minimax').some(p => p.id === 'healthnet'), false);
  assert.equal(getEligibilityPortalsForProject('medrevenue').some(p => p.id === 'healthnet'), true);
  const form = new FormData(); form.set('projectId', 'minimax');
  assert.throws(() => createHealthNetEligibilityRunner().validateInput(form), /only/);
  const input = await file([['Project', 'Primary Insurance Name', 'Member ID', 'DOB'], ['MedRevenu', 'Health Net', '00123', '01/01/1980'], ['Minimax', 'Health Net', '999', '01/01/1980'], ['MedRevenu', 'IEHP', '888', '01/01/1980']]);
  const rows = await readHealthNetInput(input);
  assert.equal(rows.length, 1); assert.equal(rows[0].originalIndex, 2); assert.equal(rows[0].memberId, '00123');
  const credentials = await file([['Project', 'Portal', 'Email Address', 'Password', 'Link'], ['Minimax', 'Health Net', 'wrong', 'wrong', 'https://wrong.test'], ['MedRevenu', 'IEHP', 'wrong', 'wrong', 'https://wrong.test'], ['MedRevenu', 'Health Net', 'test@example.test', 'test-password', 'https://healthnet.test/login']]);
  assert.equal((await readHealthNetCredentials(credentials)).username, 'test@example.test');
  const suppliedFormat = await file([['Project', 'Portal', 'Payer', 'URL', 'User Name', 'Password'],
    ['Medrevenu\u00a0', 'Healthnet portal\u00a0', 'Health Net', 'https://healthnet.test/careconnect', 'test@example.test', 'test-password']]);
  assert.deepEqual(await readHealthNetCredentials(suppliedFormat), {
    username: 'test@example.test', password: 'test-password', loginUrl: 'https://healthnet.test/careconnect',
  });
  await assert.rejects(readHealthNetCredentials(await file([['Project', 'Portal'], ['Minimax', 'Health Net']])), /exactly one/);
});

test('Health Net extracts PPG name, preserves aligned history and existing output columns', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(); await page.setContent(response);
    const result = await extractHealthNetResult(page, 2);
    assert.equal(result.patientName, 'Jane Doe'); assert.equal(result.planName, 'Example PPG');
    assert.equal(result.memberId, '00123'); assert.equal(result.coverageStatus, 'active');
    assert.equal(result.effectiveDate, '01/01/2026 | 01/01/2025');
    assert.equal(result.terminationDate, '- | 12/31/2025'); assert.equal(result.planType, 'HMO | PPO');
    const input = await file([['Primary Insurance Name', 'Member ID', 'DOB'], ['Health Net', '00123', '01/01/1980']]);
    const rows = await readHealthNetInput(input);
    const output = await buildHealthNetOutput({ inputFile: input, rows: new Map([[2, rows[0]]]), results: new Map([[2, result]]), errors: new Map() });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(new Uint8Array(output).buffer);
    const sheet = wb.worksheets[0]; const columns: Record<string, number> = {};
    sheet.getRow(1).eachCell((cell, index) => { columns[cell.text] = index; });
    assert.equal(sheet.getCell(2, columns.Member).text, '00123');
    assert.equal(sheet.getCell(2, columns['Patient Eligibility for Today']).text, result.planStatus);
    assert.equal(sheet.getCell(2, columns['Plan Name']).text, 'Example PPG');
    for (const name of ['Coverage Status', 'Eff Date', 'End Date', 'Plan Type', 'Plan Date', 'Service Type', 'Other Ins']) assert.ok(columns[name]);
    await page.setContent(response.replace('is eligible', 'is not eligible'));
    assert.equal((await extractHealthNetResult(page, 3)).coverageStatus, 'inactive');
  } finally { await browser.close(); }
});

test('Health Net selects Text Message, requests frontend OTP, verifies it, and searches two members', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const job = createScrapeJob(undefined, 'eligibility-verification');
  try {
    const page = await browser.newPage();
    await page.route('https://healthnet.test/**', async route => {
      if (route.request().url().endsWith('/login')) {
        await route.fulfill({ contentType: 'text/html', body: `<input id="username"><button id="nextButton" onclick="document.querySelector('#pw').hidden=false">Continue</button>
          <div id="pw" hidden><input id="password" type="password"><button id="loginButton" onclick="document.querySelector('#mfa').hidden=false">Login</button></div>
          <div id="mfa" hidden><label><input id="sms" type="radio"><span class="MuiFormControlLabel-label">Text Message: ***-***-9999</span></label>
          <button id="continueMfa" onclick="if(document.querySelector('#sms').checked){document.querySelector('#entry').hidden=false;this.hidden=true}">Send Code</button></div>
          <div id="entry" hidden><input autocomplete="one-time-code"><button onclick="if(document.querySelector('[autocomplete=one-time-code]').value==='012345')location.href='/eligibility'">Verify Code</button></div>` });
      } else {
        await route.fulfill({ contentType: 'text/html', body: `<div style="height:1500px">Health Net</div><form onsubmit="event.preventDefault();document.querySelector('#result').innerHTML=document.querySelector('#template').innerHTML.replace('00123',document.querySelector('[name=memberIdOrLastName]').value)"><input name="memberIdOrLastName"><input name="dob"><button name="submit" type="submit">Check Eligibility</button></form><div id="result"></div><template id="template">${response}</template>` });
      }
    });
    let requested = false;
    const url = await loginHealthNet(page, { username: 'test@example.test', password: 'test-password', loginUrl: 'https://healthnet.test/login' }, {
      jobId: job.id, workflowId: 'eligibility-verification', portalId: 'healthnet', log: async () => {},
      emit: async event => {
        if (event.type === 'otp_request') {
          requested = true;
          assert.match(String(event.label), /Health Net text message/);
          assert.equal(await page.locator('#sms').isChecked(), true);
          setImmediate(() => submitScrapeJobInput(job.id, String(event.inputName), '012345'));
        }
      },
    });
    assert.equal(requested, true);
    for (const memberId of ['00123', '00456']) {
      const result = await verifyHealthNetRow(page, url, { originalIndex: 2, memberId, dateOfBirth: '01/01/1980', raw: {} });
      assert.equal(result.memberId, memberId); assert.equal(result.coverageStatus, 'active');
    }
  } finally {
    for (const [inputName] of job.inputWaiters) submitScrapeJobInput(job.id, inputName, '');
    await browser.close();
  }
});
