import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import ExcelJS from "exceljs";
import { extractIehpResult, setIehpDos, verifyIehpRow } from "./portal";
import { buildIehpOutput, readIehpInput, iehpOutputValues } from "./data";
import { createIehpEligibilityRunner } from "./scraper";
import { getEligibilityPortalsForProject } from "@/frontend/src/workflows/eligibility-verification/registry";

test("IEHP is restricted to MedRevenue", () => {
  assert.equal(getEligibilityPortalsForProject("minimax").some(p => p.id === "iehp"), false);
  assert.equal(getEligibilityPortalsForProject("medrevenue").some(p => p.id === "iehp"), true);
  const form = new FormData(); form.set("projectId", "minimax");
  assert.throws(() => createIehpEligibilityRunner().validateInput(form), /only/);
});

test("IEHP extracts two patients without document reload when results add a second eligibility-state link", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    let loads = 0;
    await page.route('https://iehp.test/eligibility', async route => {
      loads++;
      await route.fulfill({ contentType: 'text/html', body: `
        <a ui-sref="eligibility" ui-sref-active="active" ui-sref-opts="{reload: true}" href="/eligibility" onclick="event.preventDefault();document.querySelector('#search').value='';document.querySelector('#results').innerHTML=''">Eligibility</a>
        <div style="height:1500px">Eligibility information</div>
        <form onsubmit="event.preventDefault(); document.querySelector('#results').innerHTML = document.querySelector('#response').innerHTML;">
          <input id="search" ng-model="model.input">
          <div><span>DOS</span><button type="button" id="date" onclick="document.querySelector('#calendar').hidden=false">09/10/2026</button></div>
          <div id="calendar" class="_720kb-datepicker-calendar" hidden>
            <div class="_720kb-datepicker-calendar-header-left"><a href="#" onclick="event.preventDefault();document.querySelector('#month').textContent='August 2026'">Previous</a></div>
            <div id="month" class="_720kb-datepicker-calendar-header-middle _720kb-datepicker-calendar-month">September 2026</div>
            <a href="#" class="_720kb-datepicker-calendar-day" onclick="event.preventDefault();document.querySelector('#date').textContent='08/14/2026';document.querySelector('#calendar').hidden=true">14</a>
          </div>
          <button type="submit">Search</button>
        </form><div id="results"></div>
        <template id="response"><a href="/eligibility" ui-sref="eligibility" class="back-to-reslt non-printable ng-hide" onclick="event.preventDefault();document.body.dataset.wrongLink='true'">Back to Search Results</a><div>Status<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:green"></span></div>
          <div class="elig-label">Plan</div><div>Medi-Cal</div><div class="elig-label">Eff. Date</div><div>01/01/2026</div>
          <div class="elig-label">OHC</div><div>No</div><div class="elig-label">Medicare ID</div><div>00123</div>
          <div class="elig-label">IPA</div><div>Test IPA</div><div class="elig-label">Hospital</div><div>Test Hospital</div>
        </template>` });
    });
    await page.goto('https://iehp.test/eligibility');
    for (const memberId of ['00123', '00456']) {
      const steps: string[] = [];
      const result = await verifyIehpRow(page, page.url(), { originalIndex: 2, raw: {}, memberId, dateOfService: '08/14/2026' }, async message => { steps.push(message); });
      assert.equal(await page.locator('#search').inputValue(), memberId);
      assert.equal(await page.locator('#date').innerText(), '08/14/2026');
      assert.equal(result.coverageStatus, 'active');
      assert.equal(result.planName, 'Medi-Cal');
      assert.equal(steps.length, 4);
      assert.equal(await page.locator('a[ui-sref="eligibility"][href="/eligibility"]').count(), 2);
      assert.equal(await page.locator('body').getAttribute('data-wrong-link'), null);
      assert.ok(await page.evaluate(() => window.scrollY > 0));
    }
    assert.equal(loads, 1);
  } finally { await browser.close(); }
});

test("IEHP DOS supports attribute datepickers, closed calendars and delayed inputs", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const search = '<input id="search" ng-model="model.input">';
    for (const markup of [
      '<div datepicker><input id="service"></div>',
      '<div data-datepicker><input id="service"><div hidden class="_720kb-datepicker-calendar-header-middle _720kb-datepicker-calendar-month">September 2026</div></div>',
      '<label for="service">Date of Service (DOS)</label><input id="service" type="date">',
    ]) {
      await page.setContent(`<form>${search}${markup}</form><datepicker><input id="unrelated"></datepicker>`);
      await setIehpDos(page, "08/14/2026");
      const native = await page.locator('#service').getAttribute('type') === 'date';
      assert.equal(await page.locator('#service').inputValue(), native ? '2026-08-14' : '08/14/2026');
      assert.equal(await page.locator('#unrelated').inputValue(), '');
    }
    await page.setContent(`<form>${search}<div id="later"></div></form>`);
    await page.evaluate(() => { setTimeout(() => {
      document.getElementById('later')!.innerHTML = '<div datepicker><input id="service"></div>';
    }, 100); });
    await setIehpDos(page, '08/14/2026');
    assert.equal(await page.locator('#service').inputValue(), '08/14/2026');
    await page.setContent(`<form>${search}<datepicker><input id="dob"></datepicker><div datepicker><label for="service">DOS</label><input id="service"></div></form>`);
    await setIehpDos(page, '08/14/2026');
    assert.equal(await page.locator('#dob').inputValue(), '');
    assert.equal(await page.locator('#service').inputValue(), '08/14/2026');
    await page.setContent(`<form>${search}<div datepicker><input><input></div></form>`);
    await assert.rejects(setIehpDos(page, '08/14/2026'), /multiple possible DOS/);
    await page.setContent(`<form>${search}</form>`);
    await assert.rejects(setIehpDos(page, '08/14/2026', 100), /DOS input was not found/);
  } finally { await browser.close(); }
});

test("IEHP extracts DOM colors, DOS and output fields without altering other rows", async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await browser.newPage();
    const fields = { Plan: "Medi-Cal", "Eff. Date": "01/01/2026", OHC: "Yes", "Medicare ID": "00123", IPA: "Test IPA", Hospital: "Test Hospital" };
    const html = (dot: string) => `<div style="color:green">Unrelated status</div><div>Status${dot}</div>` + Object.entries(fields).map(([k,v]) => `<div><div class="elig-label col-xs-5">${k}</div><div>${v}</div></div>`).join("");
    for (const [color, expected] of [["green", "active"], ["red", "inactive"]]) {
      await page.setContent(html(`<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${color}"></span>`));
      assert.equal((await extractIehpResult(page, 2)).coverageStatus, expected);
    }
    await page.setContent(html('<i class="dot"></i>') + '<style>.dot:before {content:"\\25cf";color:green}</style>');
    const result = await extractIehpResult(page, 2);
    assert.equal(result.coverageStatus, "active");
    assert.equal(result.planName, fields.Plan);
    assert.equal(result.metadata?.medicareId, "00123");
    const withoutMedicare = html('<span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:green"></span>')
      .replace('<div><div class="elig-label col-xs-5">Medicare ID</div><div>00123</div></div>', '');
    await page.setContent(withoutMedicare);
    const noMedicare = await extractIehpResult(page, 3);
    assert.equal(noMedicare.metadata?.medicareId, '');
    assert.deepEqual(iehpOutputValues(noMedicare), {
      'Coverage Status': 'Active Coverage', 'Eff Date': fields['Eff. Date'], Plan: fields.Plan,
      OHC: fields.OHC, 'Medicare ID': '', IPA: fields.IPA, Hospital: fields.Hospital, error: '',
    });
    await page.setContent(withoutMedicare + '<div class="elig-label">Medicare ID</div><div></div>');
    assert.equal((await extractIehpResult(page, 4)).metadata?.medicareId, '');
    await page.setContent(withoutMedicare + '<div class="elig-label">Medicare ID</div><div>111</div><div class="elig-label">Medicare ID</div><div>222</div>');
    await assert.rejects(extractIehpResult(page, 5), /ambiguous: Medicare ID/);
    await page.setContent(html('<span style="color:green">ELIGIBLE</span>'));
    await assert.rejects(extractIehpResult(page, 2), /IEHP Status/);
    await page.setContent('<datepicker><input><div class="_720kb-datepicker-calendar-header-middle _720kb-datepicker-calendar-month">September 2026</div></datepicker>');
    await setIehpDos(page, "08/14/2026");
    assert.equal(await page.locator("input").inputValue(), "08/14/2026");
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("Input").addRows([["Project", "Primary Insurance Name", "Member ID", "DOS"], ["MedRevenu", "IEHP", "00123", "08/14/2026"], ["Minimax", "IEHP", "999", "08/14/2026"], ["MedRevenue", "Aetna", "888", "08/14/2026"]]);
    const file = new File([new Uint8Array(await wb.xlsx.writeBuffer())], "input.xlsx");
    const rows = await readIehpInput(file);
    assert.equal(rows.length, 1); assert.equal(rows[0].originalIndex, 2);
    const output = await buildIehpOutput({ inputFile: file, rows: new Map([[2, rows[0]]]), results: new Map([[2, result]]), errors: new Map() });
    const out = new ExcelJS.Workbook(); await out.xlsx.load(new Uint8Array(output).buffer);
    const sheet = out.getWorksheet("Output")!; const cols: Record<string, number> = {};
    sheet.getRow(1).eachCell((c,i) => { cols[c.text] = i; });
    assert.equal(sheet.getCell(2, cols["Coverage Status"]).text, "Active Coverage");
    assert.equal(sheet.getCell(2, cols["Medicare ID"]).text, "00123");
    for (const header of ["Plan Date", "Eff Date", "OHC", "IPA", "Hospital", "Service Type"]) assert.ok(cols[header]);
    assert.equal(sheet.getCell(3, cols["Coverage Status"]).text, "");
  } finally { await browser.close(); }
});
