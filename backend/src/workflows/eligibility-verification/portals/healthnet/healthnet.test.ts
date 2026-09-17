import assert from 'node:assert/strict';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { chromium } from 'playwright-core';
import { createHealthNetEligibilityRunner } from './scraper';
import { readHealthNetInput, readHealthNetCredentials, buildHealthNetOutput } from './data';
import { extractHealthNetResult, loginHealthNet, recoverHealthNetLogin, verifyHealthNetRow, waitForHealthNetLoginScreen, selectHealthNetTextMessage } from './portal';
import { getEligibilityPortalsForProject } from '@/frontend/src/workflows/eligibility-verification/registry';
import { createScrapeJob, submitScrapeJobInput } from '@/backend/src/jobs/job-store';
import { enterHealthNetUsername, healthNetMemberIdsMatch } from './portal';

test('Health Net retries an email cleared during rendering and rejects persistently truncated input', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    const logs: string[] = [];
    const context = { jobId: 'email-test', workflowId: 'eligibility-verification' as const, portalId: 'healthnet', emit: async () => {}, log: async (event: { message: string }) => { logs.push(event.message); } };
    await page.setContent(`<input id="username" onblur="if(!window.reset){window.reset=true;setTimeout(()=>this.value='',100)}"><button id="nextButton">Continue</button>`);
    await enterHealthNetUsername(page, 'test@example.test', context);
    assert.equal(await page.locator('#username').inputValue(), 'test@example.test');
    assert.ok(logs.some(message => message.includes('Re-entering')));
    await page.setContent('<input id="username" maxlength="3"><button id="nextButton" onclick="window.continued=true">Continue</button>');
    await assert.rejects(enterHealthNetUsername(page, 'test@example.test', context), /complete username after three/);
    assert.equal(await page.evaluate('window.continued'), undefined);
  } finally { await browser.close(); }
});

test('Health Net member matching ignores formatting but preserves identity and leading zeros', () => {
  assert.equal(healthNetMemberIdsMatch(' ab-001 23 ', 'AB00123'), true);
  assert.equal(healthNetMemberIdsMatch('00123', '123'), false);
  assert.equal(healthNetMemberIdsMatch('AB00123-01', 'AB00123'), false);
  assert.equal(healthNetMemberIdsMatch('00124', '00123'), false);
  assert.equal(healthNetMemberIdsMatch('', ''), false);
  assert.equal(healthNetMemberIdsMatch('R00001234MD1', 'R00001234'), true);
  assert.equal(healthNetMemberIdsMatch('R00001234', 'R00001234MD1'), true);
  assert.equal(healthNetMemberIdsMatch('R00001235MD1', 'R00001234'), false);
  assert.equal(healthNetMemberIdsMatch('R00001234MD2', 'R00001234MD1'), false);
  assert.equal(healthNetMemberIdsMatch('R00001234MD12', 'R00001234'), false);
});

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

test('Health Net reads legacy Insurance and mislabeled member ID columns without losing row positions', async () => {
  const input = await file([
    ['DOS', 'Patient Name ', 'DOB', 'Insurance ', 'Primary Insurance Name"', 'Project'],
    ['09/15/2026', 'Doe, Jane', '01/01/1980', ' Healthnet ', '00123', 'MedRevenu'],
    [],
    ['09/15/2026', 'Doe, John', '01/01/1980', 'HEALTHNET', '00456', ''],
    ['09/15/2026', 'Doe, Jane', '01/01/1980', 'IEHP', '00789', 'MedRevenu'],
    ['09/15/2026', 'Doe, Jane', '01/01/1980', 'Healthnet', '00999', 'Minimax'],
  ]);
  const rows = await readHealthNetInput(input);
  assert.deepEqual(rows.map(row => [row.originalIndex, row.memberId]), [[2, '00123'], [4, '00456']]);
  assert.equal(rows[0].patientFirstName, 'Jane');
  assert.equal(rows[0].dateOfBirth, '01/01/1980');
  assert.equal(rows[0].dateOfService, '09/15/2026');
  const standard = await file([
    ['Insurance', 'Primary Insurance Name"', 'Member ID'],
    ['Healthnet', 'IEHP', '00123'],
    ['IEHP', 'Health Net', '00456'],
  ]);
  assert.deepEqual((await readHealthNetInput(standard)).map(row => row.memberId), ['00456']);
});

test('Health Net extracts PPG name, preserves aligned history and existing output columns', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage(); await page.setContent(response.replace('<p>00123</p>', '<p>00123MD1</p>'));
    const result = await extractHealthNetResult(page, 2);
    assert.equal(result.patientName, 'Jane Doe'); assert.equal(result.planName, 'Example PPG');
    assert.equal(result.memberId, '00123MD1'); assert.equal(result.coverageStatus, 'active');
    assert.equal(healthNetMemberIdsMatch(result.memberId, '00123'), true);
    assert.equal(result.effectiveDate, '01/01/2026 | 01/01/2025');
    assert.equal(result.terminationDate, '- | 12/31/2025'); assert.equal(result.planType, 'HMO | PPO');
    const input = await file([['Primary Insurance Name', 'Member ID', 'DOB'], ['Health Net', '00123', '01/01/1980']]);
    const rows = await readHealthNetInput(input);
    const output = await buildHealthNetOutput({ inputFile: input, rows: new Map([[2, rows[0]]]), results: new Map([[2, result]]), errors: new Map() });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(new Uint8Array(output).buffer);
    const sheet = wb.worksheets[0]; const columns: Record<string, number> = {};
    sheet.getRow(1).eachCell((cell, index) => { columns[cell.text] = index; });
    assert.equal(sheet.getCell(2, columns.Member).text, '00123MD1');
    assert.equal(sheet.getCell(2, columns['Patient Eligibility for Today']).text, result.planStatus);
    assert.equal(sheet.getCell(2, columns['Plan Name']).text, 'Example PPG');
    assert.equal(sheet.getCell(2, columns['Eff Date']).text, '01/01/2026 | 01/01/2025');
    assert.equal(sheet.getCell(2, columns['End Date']).text, '- | 12/31/2025');
    assert.equal(sheet.getCell(2, columns['Plan Type']).text, 'HMO | PPO');
    await page.setContent(response.replace('<h4 class="title">Member #</h4><p>00123</p>', '<div><h4 class="title">Member #</h4></div><p>00123</p><span>Additional information</span>'));
    assert.equal((await extractHealthNetResult(page, 2)).memberId, '00123');
    await page.setContent(response.replace(/<table>[\s\S]*<\/table>/, `<table><thead><tr><th>Start<br>Date</th><th>End<br>Date</th><th id="elig_hist_productname">Product Name</th><th>Product Description</th></tr></thead><tbody><tr><th>Feb 1,<br>2026</th><td>Ongoing</td><td>HMO WholeCare<br>Small Group<br>(Platinum, Gold, Silver)</td><td>Different description</td></tr></tbody></table>`));
    const wrapped = await extractHealthNetResult(page, 2);
    assert.equal(wrapped.effectiveDate, 'Feb 1, 2026');
    assert.equal(wrapped.terminationDate, 'Ongoing');
    assert.equal(wrapped.planType, 'HMO WholeCare Small Group (Platinum, Gold, Silver)');
    await page.setContent((await page.content()).replace(/<td>/g, '<th>').replace(/<\/td>/g, '</th>'));
    const headerCells = await extractHealthNetResult(page, 2);
    assert.equal(headerCells.effectiveDate, wrapped.effectiveDate);
    assert.equal(headerCells.terminationDate, 'Ongoing');
    assert.equal(headerCells.planType, wrapped.planType);
    await page.locator('tbody').evaluate(element => { element.replaceChildren(); });
    const noHistory = await extractHealthNetResult(page, 2);
    assert.equal(noHistory.coverageStatus, 'active');
    assert.equal(noHistory.planName, 'Example PPG');
    assert.equal(noHistory.memberId, '00123');
    assert.equal(noHistory.effectiveDate, '');
    await page.setContent(response.replace('<h3>PPG Information</h3>', '<h3>PCP Information</h3><div><h4 class="title">Name</h4><p>Provider Name</p></div><h3>PPG Information</h3>'));
    const extraNames = await extractHealthNetResult(page, 2);
    assert.equal(extraNames.patientName, 'Jane Doe');
    assert.equal(extraNames.planName, 'Example PPG');
    assert.equal(extraNames.coverageStatus, 'active');
    assert.equal(extraNames.effectiveDate, '01/01/2026 | 01/01/2025');
    await page.setContent(response.replace('<h3>Patient Information</h3>', '<h3>Other Information</h3>'));
    const missingPatientSection = await extractHealthNetResult(page, 2);
    assert.equal(missingPatientSection.patientName, '');
    assert.equal(missingPatientSection.planName, 'Example PPG');
    assert.equal(missingPatientSection.coverageStatus, 'active');
    const wrappedOutput = await buildHealthNetOutput({ inputFile: input, rows: new Map([[2, rows[0]]]), results: new Map([[2, wrapped]]), errors: new Map() });
    const wrappedWorkbook = new ExcelJS.Workbook();
    await wrappedWorkbook.xlsx.load(new Uint8Array(wrappedOutput).buffer);
    for (const [header, expected] of Object.entries({ 'Eff Date': wrapped.effectiveDate, 'End Date': 'Ongoing', 'Plan Type': wrapped.planType })) {
      assert.equal(wrappedWorkbook.worksheets[0].getCell(2, columns[header]).text, expected);
    }
    await page.setContent(response.replace('<p>00123</p>', '<span>:</span><p><span hidden>OLD-ID</span>00123</p>'));
    assert.equal((await extractHealthNetResult(page, 2)).memberId, '00123');
    for (const name of ['Coverage Status', 'Eff Date', 'End Date', 'Plan Type', 'Plan Date', 'Service Type', 'Other Ins']) assert.ok(columns[name]);
    await page.setContent(response.replace('is eligible', 'is not eligible'));
    assert.equal((await extractHealthNetResult(page, 3)).coverageStatus, 'inactive');
  } finally { await browser.close(); }
});

test('Health Net selects Text Message, verifies OTP, opens dashboard Eligibility and View details for two members', async () => {
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
          <div id="entry" hidden><input autocomplete="one-time-code"><button onclick="if(document.querySelector('[autocomplete=one-time-code]').value==='012345')location.href='/home'">Verify Code</button></div>` });
      } else if (route.request().url().endsWith('/home')) {
        await route.fulfill({ contentType: 'text/html', body: '<h1>Health Net dashboard</h1><a href="/careconnect/eligibility/bulkChecker" class="eligibility"><i></i> Eligibility</a>' });
      } else {
        await route.fulfill({ contentType: 'text/html', body: `<div style="height:1500px">Health Net</div>
          <form onsubmit="event.preventDefault();setTimeout(()=>document.querySelector('#summary').hidden=false,150)">
          <input name="dos" id="dos" class="mask-date" value="09/15/2026"><input name="memberIdOrLastName"><input name="dob" class="mask-date"><input type="submit" name="check" class="btn btn-success" value="Check Eligibility"></form>
          <script>
          for (const field of document.querySelectorAll('.mask-date')) {
            field.oninput=()=>{const digits=field.value.replace(/[^0-9]/g,'').slice(0,8);field.value=digits.slice(0,2)+(digits.length>2?'/'+digits.slice(2,4):'')+(digits.length>4?'/'+digits.slice(4):'')};
            field.onblur=()=>{if(field.value.length!==10)field.value=''};
          }
          </script>
          <div id="summary" hidden><span class="viewdetails fa-angle-right" onclick="document.body.dataset.detailsClicked='true';setTimeout(()=>{document.querySelector('#result').innerHTML=document.querySelector('#template').innerHTML.replace('00123',document.querySelector('[name=memberIdOrLastName]').value)},150)">View details</span></div>
          <div id="result"></div><template id="template">${response}</template>` });
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
      const result = await verifyHealthNetRow(page, url, { originalIndex: 2, memberId, dateOfBirth: '01/01/1980', dateOfService: '09/02/2026', raw: {} });
      assert.equal(await page.locator('#dos').inputValue(), '09/02/2026');
      assert.equal(await page.locator('[name=dob]').inputValue(), '01/01/1980');
      assert.equal(new URL(url).pathname, '/careconnect/eligibility/bulkChecker');
      assert.equal(result.memberId, memberId); assert.equal(result.coverageStatus, 'active');
      assert.equal(await page.locator('body').getAttribute('data-details-clicked'), 'true');
      assert.equal(result.planName, 'Example PPG');
      assert.equal(result.effectiveDate, '01/01/2026 | 01/01/2025');
      assert.equal(result.terminationDate, '- | 12/31/2025');
      assert.equal(result.planType, 'HMO | PPO');
    }
  } finally {
    for (const [inputName] of job.inputWaiters) submitScrapeJobInput(job.id, inputName, '');
    await browser.close();
  }
});

test('Health Net proceeds after delayed direct login without requesting OTP or waiting for SMS', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const destination of ['home', 'eligibility']) {
      const page = await browser.newPage();
      await page.route('https://healthnet.test/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/login') {
          await route.fulfill({ contentType: 'text/html', body: `<input id="username"><button id="nextButton" onclick="document.querySelector('#pw').hidden=false">Continue</button>
            <div id="pw" hidden><input id="password"><button id="loginButton" onclick="setTimeout(()=>location.href='/${destination}',300)">Login</button></div>` });
        } else if (path === '/home') {
          await route.fulfill({ contentType: 'text/html', body: '<h1>Health Net</h1><a href="/eligibility"><span>Eligibility</span></a><input name="memberIdOrLastName"><input name="dob">' });
        } else {
          await route.fulfill({ contentType: 'text/html', body: '<input name="memberIdOrLastName"><input name="dob">' });
        }
      });
      const logs: string[] = [];
      const url = await loginHealthNet(page, { username: 'test', password: 'test', loginUrl: 'https://healthnet.test/login' }, {
        jobId: 'direct-login', workflowId: 'eligibility-verification', portalId: 'healthnet',
        log: async event => { logs.push(event.message); },
        emit: async event => { assert.notEqual(event.type, 'otp_request'); },
      });
      assert.equal(url, 'https://healthnet.test/eligibility');
      assert.equal(page.isClosed(), false);
      assert.equal(logs.some(message => message.includes('Text Message verification screen')), false);
      if (destination === 'home') assert.ok(logs.some(message => message.includes('Opening Eligibility from the dashboard')));
      await page.close();
    }
  } finally { await browser.close(); }
});
