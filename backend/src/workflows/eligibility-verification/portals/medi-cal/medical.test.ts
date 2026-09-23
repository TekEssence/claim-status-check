import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { chromium } from 'playwright-core';
import { readMediCalInput, readMediCalCredentials, buildMediCalOutput } from './data';
import { extractMediCalResult, loginMediCal, openMediCalLoginPage, waitForMediCalLogin, verifyMediCalRow } from './portal';
import { createMediCalEligibilityRunner } from './scraper';
import { getEligibilityPortalsForProject } from '@/frontend/src/workflows/eligibility-verification/registry';
import { mediCalDatesMatch, mediCalIssueDate } from './dates';
import { mediCalCalendarFixture } from './calendar-fixture';

test('Medi-Cal extracts coverage and subscriber fields from wrapped, associated and narrative values', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    for (const fields of [
      '<div><div><span id="medicare-id-label">Medicare ID:</span></div><div>TEST123</div></div><table><tr><th><span id="subscriber-name-label">Subscriber Name:</span></th><td>TEST PERSON</td></tr></table>',
      '<label id="medicare-id-label" for="result-id">Medicare ID:</label><input id="result-id" value="TEST123"><div id="subscriber-name-label">Subscriber Name:</div><div aria-labelledby="subscriber-name-label">TEST PERSON</div>',
      '',
    ]) {
      await page.setContent(`<div id="status-area">MEDI-CAL ELIGIBLE.\nMedicare ID: TEST123\nSubscriber Name: TEST PERSON</div>${fields}`);
      const result = await extractMediCalResult(page, 2);
      assert.equal(result.coverageStatus, 'active');
      assert.equal(result.metadata?.medicareId, 'TEST123');
      assert.equal(result.patientName, 'TEST PERSON');
    }
    for (const [message, status] of [
      ['Subscriber is not eligible for the requested service date.', 'inactive'],
      ['Subscriber is eligible for Medi-Cal.', 'active'],
      ['No eligibility information is available.', 'unknown'],
      ['Eligibility inquiry completed.', 'unknown'],
    ]) {
      await page.setContent(`<div id="status-area">${message}</div><div id="medicare-id-label">Medicare ID:</div><div id="subscriber-name-label">Subscriber Name:</div>`);
      const result = await extractMediCalResult(page, 2);
      assert.equal(result.coverageStatus, status);
      assert.equal(result.metadata?.medicareId, '');
      assert.equal(result.patientName, '');
    }
  } finally { await browser.close(); }
});

test('Medi-Cal rejects portal system errors without treating them as eligibility results', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    for (const message of [
      'Your transaction could not be processed properly at this time. There was a system error while processing your transaction. NOTE: The system is unavailable between the scheduled hours.',
      'The service is temporarily unavailable.',
      'Your session has expired.',
    ]) {
      await page.setContent('<div id="status-area"></div>');
      await page.locator('#status-area').evaluate((element, text) => { element.textContent = text; }, message);
      await assert.rejects(extractMediCalResult(page, 2), error => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(message));
        assert.match(error.message, /no eligibility data was returned/);
        return true;
      });
    }
    await page.setContent('<div id="status-area">Subscriber is not eligible for the requested service date.</div>');
    assert.match((await extractMediCalResult(page, 2)).coverageDescription!, /not eligible/);
  } finally { await browser.close(); }
});

test('Medi-Cal is MedRevenue only', () => {
  assert.equal(getEligibilityPortalsForProject('minimax').some(p => p.id === 'medical'), false);
  assert.equal(getEligibilityPortalsForProject('medrevenue').some(p => p.id === 'medical'), true);
  const form = new FormData(); form.set('projectId', 'minimax');
  assert.throws(() => createMediCalEligibilityRunner().validateInput(form), /only/);
});

test('Medi-Cal filters mixed inputs and updates only matching rows, reusing Description', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Input').addRows([
    ['Project', 'Primary Insurance Name', 'Subscriber ID', 'Issue Date', 'Subscriber Birth Date', 'Service Date', 'Description'],
    ['MedRevenue', 'Medi-Cal', '00123', '08/01/2026', '01/02/1960', '09/10/2026', 'old'],
    ['MedRevenue', 'IEHP', '999', '', '', '', 'keep'],
    ['MiniMax', 'Medi-Cal', '888', '', '', '', 'keep too'],
  ]);
  const file = new File([new Uint8Array(await book.xlsx.writeBuffer())], 'input.xlsx');
  const rows = await readMediCalInput(file);
  assert.equal(rows.length, 1); assert.equal(rows[0].subscriberId, '00123');
  const result = { rowIndex: 2, payerId: 'medical', coverageStatus: 'unknown' as const, benefits: [], coverageDescription: 'Full eligibility result.', patientName: 'TEST PERSON', metadata: { medicareId: 'TEST123' } };
  const output = await buildMediCalOutput({ inputFile: file, rows: new Map([[2, rows[0]]]), results: new Map([[2, result]]), errors: new Map() });
  const loaded = new ExcelJS.Workbook(); await loaded.xlsx.load(new Uint8Array(output).buffer);
  const sheet = loaded.getWorksheet("Output")!;
  assert.equal(sheet.getCell('G2').text, 'Full eligibility result.');
  assert.equal(sheet.getCell('G3').text, 'keep'); assert.equal(sheet.getCell('G4').text, 'keep too');
  const headers = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1);
  assert.deepEqual(headers.slice(7), ['Coverage Status', 'Eff Date', 'End Date', 'Other Ins', 'Other Ins Eff Date', 'Relationship to Subscriber', 'Plan Type', 'Bot Insurance Type', 'Plan Date', 'Service Type', 'Medicare ID', 'Subscriber Name', 'error']);
  const column = (header: string) => headers.indexOf(header) + 1;
  assert.equal(sheet.getCell(2, column('Medicare ID')).text, 'TEST123');
  assert.equal(sheet.getCell(2, column('Subscriber Name')).text, 'TEST PERSON');
  assert.equal(sheet.getCell(2, column('Coverage Status')).text, 'unknown');
  assert.equal(sheet.getCell(2, column('Eff Date')).text, '-');
  assert.equal(sheet.getCell('F2').text, '09/10/2026');
  for (const header of ['Description', 'Medicare ID', 'Subscriber Name', 'error']) {
    assert.deepEqual(sheet.getCell(1, column(header)).style, sheet.getCell(1, column('Coverage Status')).style);
    assert.deepEqual(sheet.getCell(2, column(header)).style, sheet.getCell(2, column('Coverage Status')).style);
  }
  assert.equal(sheet.getCell(3, column('Coverage Status')).text, '');
  assert.equal(sheet.getCell(4, column('Coverage Status')).text, '');
  assert.equal(sheet.getColumn(column('Description')).width, 60);
});

test('Medi-Cal standard output supports legacy XLS, snapshots and failed rows', async () => {
  const source = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(source, XLSX.utils.aoa_to_sheet([
    ['Primary Insurance Name', 'Member ID', 'DOS'],
    ['Medi-Cal', '00123', '09/10/2026'],
  ]), 'Input');
  const inputFile = new File([new Uint8Array(XLSX.write(source, { type: 'buffer', bookType: 'biff8' }))], 'input.xls');
  const [row] = await readMediCalInput(inputFile);
  for (const errors of [new Map<number, string>(), new Map([[2, 'Portal timeout']])]) {
    const output = await buildMediCalOutput({ inputFile, rows: new Map([[2, row]]), results: new Map(), errors });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(new Uint8Array(output).buffer);
    const sheet = book.getWorksheet("Output")!;
    const headers = (sheet.getRow(1).values as ExcelJS.CellValue[]).slice(1);
    const cell = (header: string) => sheet.getCell(2, headers.indexOf(header) + 1);
    assert.equal(cell('Member ID').text, '00123');
    assert.equal(cell('DOS').text, '09/10/2026');
    assert.equal(cell('Coverage Status').text, errors.size ? 'error' : '-');
    assert.equal(cell('error').text, errors.size ? 'Portal timeout' : '');
    assert.equal(cell('Description').alignment.wrapText, true);
    assert.equal(cell('Medicare ID').border.bottom?.style, 'thin');
  }
});

test('MedRevenu medical accepts Medicare and Molina while preserving worksheet row numbers', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Input').addRows([
    ['Project', 'Primary Insurance Name', 'Subscriber ID'],
    ['Medrevenu', 'medicare', '00123'],
    [],
    ['Medrevenu', 'molina', '00456'],
    ['Medrevenu', 'medicare/molina', '00789'],
    ['Minimax', 'medicare', 'excluded'],
    ['Medrevenu', 'IEHP', 'excluded'],
  ]);
  const rows = await readMediCalInput(new File([new Uint8Array(await book.xlsx.writeBuffer())], 'input.xlsx'));
  assert.deepEqual(rows.map(row => [row.originalIndex, row.subscriberId]), [[2, '00123'], [4, '00456'], [5, '00789']]);
});

test('MedRevenu medical accepts the supplied credential columns and preserves the supplied login destination', async () => {
  for (const url of ['http://www.medi-cal.ca.gov/', 'www.medi-cal.ca.gov', 'https://www.medi-cal.ca.gov/']) {
    const book = new ExcelJS.Workbook();
    book.addWorksheet('Login').addRows([
      ['Project', 'Portal', 'Payer', 'URL', 'User Name', 'Password'],
      ['Medrevenu', 'medical', 'medicare/molina', url, 'test@example.test', 'test-password'],
      ['Minimax', 'medical', 'medicare/molina', url, 'excluded', 'excluded'],
    ]);
    const credentials = await readMediCalCredentials(new File([new Uint8Array(await book.xlsx.writeBuffer())], 'login.xlsx'));
    assert.deepEqual(credentials, { username: 'test@example.test', password: 'test-password', loginUrl: url.startsWith('http') ? url : `https://${url}` });
  }
});

test('Medi-Cal follows the workbook website menu and Provider Portal link in expanded and collapsed layouts', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const collapsed of [false, true]) {
      const page = await browser.newPage();
      const visited: string[] = [];
      await page.route('https://mcweb.apps.prd.cammis.medi-cal.ca.gov/**', route => {
        const path = new URL(route.request().url()).pathname;
        visited.push(path);
        return route.fulfill({ contentType: 'text/html', body: path === '/provider-portal'
          ? '<input placeholder="Enter your Email Address"><input placeholder="Enter your Password">'
          : `<button onclick="document.querySelector('nav').hidden=false;document.body.dataset.menuOpened='yes'"><span class="ca-gov-icon-menu">Menu</span></button><nav ${collapsed ? 'hidden' : ''}><a class="text-left" href="/provider-portal">Provider Portal</a></nav>` });
      });
      await openMediCalLoginPage(page, 'https://mcweb.apps.prd.cammis.medi-cal.ca.gov/');
      assert.deepEqual(visited, ['/', '/provider-portal']);
      assert.equal(await page.locator('input').count(), 2);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Medi-Cal clicks Login and submits the email-only screen before entering the password', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    for (const direct of [false, true]) {
      const page = await browser.newPage();
      const visited: string[] = [];
      await page.route('https://www.medi-cal.ca.gov/**', route => {
        visited.push(new URL(route.request().url()).pathname);
        return route.fulfill({ contentType: 'text/html', body: '<a href="/provider-portal" onclick="event.preventDefault()">Provider Portal</a><a href="/provider-portal"><span class="ca-gov-icon-person" aria-hidden="true"></span> Login</a>' });
      });
      await page.route('https://www.medi-cal.ca.gov/provider-portal', route => route.fulfill({ status: 302, headers: { location: 'https://provider-portal.apps.prd.cammis.medi-cal.ca.gov/email' } }));
      await page.route('https://provider-portal.apps.prd.cammis.medi-cal.ca.gov/email', route => route.fulfill({ contentType: 'text/html', body: `
        <input id="b142e4ea-ff91-4a81-822d-ed25d019edb5" type="text" placeholder="Email Address" autocomplete="on" tabindex="0" maxlength="50" class="TextField-module__inputStyles__76l2b EmailEntry-module__zeroIndex__3Krvy" value="">
        <button onclick="if(document.querySelector('input').value==='test@example.test') document.body.innerHTML='<input placeholder=&quot;Enter your Password&quot; type=password><button id=login>Login</button>'; document.querySelector('#login').onclick=()=>{if(document.querySelector('input').value==='test-password') document.body.innerHTML='<input id=subscriber-id>'}">Next</button>
      ` }));
      await loginMediCal(page, {
        loginUrl: direct ? 'https://provider-portal.apps.prd.cammis.medi-cal.ca.gov/email' : 'https://www.medi-cal.ca.gov/',
        username: 'test@example.test', password: 'test-password',
      }, { timeoutMs: 2000 });
      assert.equal(await page.locator('#subscriber-id').isVisible(), true);
      assert.deepEqual(visited, direct ? [] : ['/']);
      await page.close();
    }
  } finally { await browser.close(); }
});

test('Medi-Cal maps Member ID, Date of Birth and DOS without an Issue Date column', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('Input').addRows([
    ['Primary Insurance Name', 'Member ID', 'Date of Birth', 'DOS', 'Subscriber ID', 'Service Date'],
    ['Medi-Cal', '00123', '01/02/1960', '09/10/2026', 'other-id', '08/01/2026'],
  ]);
  const [row] = await readMediCalInput(new File([new Uint8Array(await book.xlsx.writeBuffer())], 'input.xlsx'));
  assert.equal(row.subscriberId, '00123');
  assert.equal(row.dateOfBirth, '01/02/1960');
  assert.equal(row.dateOfService, '09/10/2026');
});

test('Medi-Cal distinguishes rejected login, delayed agreement, and an existing authenticated session', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<div role="alert">Invalid credentials</div>');
    await assert.rejects(waitForMediCalLogin(page, { timeoutMs: 1000 }), /login rejection/);
    await page.setContent('<input placeholder="Enter your Password">');
    await assert.rejects(waitForMediCalLogin(page, { timeoutMs: 100 }), /remained on the login page/);
    await page.setContent('<input id="subscriber-id">');
    await waitForMediCalLogin(page, { timeoutMs: 1000 });
    await page.setContent(`<div id="agreement" hidden><label><input type="checkbox" onchange="document.querySelector('#next').disabled=!this.checked">I confirm that I have read and agree to the above</label><button id="next" disabled onclick="document.body.innerHTML='<input id=subscriber-id>'">Next</button></div><script>setTimeout(()=>document.querySelector('#agreement').hidden=false, 200)</script>`);
    await waitForMediCalLogin(page, { timeoutMs: 2000 });
    assert.equal(await page.locator('#subscriber-id').isVisible(), true);
  } finally { await browser.close(); }
});

test('Medi-Cal reports country access restriction before waiting for menu or credentials', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://www.medi-cal.ca.gov/**', route => route.fulfill({ status: 403, contentType: 'text/html', body: 'The Amazon CloudFront distribution is configured to block access from your country.' }));
    await assert.rejects(openMediCalLoginPage(page, 'https://www.medi-cal.ca.gov/'), /network\/country \(HTTP 403\)/);
  } finally { await browser.close(); }
});

test('Medi-Cal supplied selectors complete login, agreement, search and fresh results for two subscribers', async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  try {
    const page = await browser.newPage();
    await page.route('https://medical.test/**', route => {
      const login = route.request().url().endsWith('/login');
      return route.fulfill({ contentType: 'text/html', body: login ? `
        <input placeholder="Enter your Email Address"><input placeholder="Enter your Password" type="password">
        <button onclick="document.querySelector('#agreement').hidden=false"><div>Log In</div></button>
        <div id="agreement" hidden><label><input type="checkbox" onchange="document.querySelector('#next').disabled=!this.checked"><div>I confirm that I have read and agree to the above</div></label>
        <button id="next" disabled onclick="document.querySelector('#eligibility').hidden=false"><div>Next</div></button></div>
        <section id="eligibility" hidden><h2>Eligibility</h2><a href='/inquiry'><span>Single Subscriber</span><p>Submit an eligibility check through the new application</p></a></section>
      ` : `
        <input id="subscriber-id">${mediCalCalendarFixture(true)}
        <button onclick="document.querySelector('#result').innerHTML='<div id=status-area>MEDI-CAL ELIGIBLE. MEDICARE ID #TEST123 . Full result text.</div><div><div id=medicare-id-label>Medicare ID:</div><div>TEST123</div></div><div><div id=subscriber-name-label>Subscriber Name:</div><div>'+document.querySelector('#subscriber-id').value+'</div></div>'"><div>Search</div></button><div id="result"></div>
      ` });
    });
    const url = await loginMediCal(page, { loginUrl: 'https://medical.test/login', username: 'test@example.test', password: 'test' });
    for (const id of ['FIRST', 'SECOND']) {
      const result = await verifyMediCalRow(page, url, { originalIndex: 2, memberId: id, dateOfBirth: '01/02/1960', dateOfService: '09/10/2026', raw: {} });
      assert.equal(result.patientName, id); assert.equal(result.metadata?.medicareId, 'TEST123');
      assert.equal(result.coverageDescription, 'MEDI-CAL ELIGIBLE. MEDICARE ID #TEST123 . Full result text.');
      assert.equal(mediCalDatesMatch(await page.locator('#issue-date').inputValue(), mediCalIssueDate()), true);
      assert.equal(await page.locator('#birth-date').inputValue(), 'January 2, 1960');
      assert.equal(await page.locator('#service-date').inputValue(), 'September 10, 2026');
    }
  } finally { await browser.close(); }
});
