import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { chromium } from "playwright-core";
import { installBrowserContextEvalHelpers } from "@/backend/src/core/playwright-browser-eval-helpers";
import { parseMemberSearchResult, type AvailityMemberRow } from "../medrevenue/data";
import { readMemberResponseFields, waitForMemberResponseFields } from "../medrevenue/result-fields";
import { buildWaystarOutputWorkbook } from "../../waystar/output";

const row: AvailityMemberRow = { originalIndex: 2, raw: {}, payerId: "molina", portalPayerName: "MOLINA HEALTHCARE CALIFORNIA", memberId: "TEST" };

test("response date ranges map both dates and preserve valid data with unavailable dates", () => {
  for (const separator of [" - ", "–", " — "]) {
    const result = parseMemberSearchResult({ status: "Active Coverage", effectiveDate: `dec 1,2023${separator}dec 1,2078` }, row);
    assert.equal(result.effectiveDate, "12/01/2023");
    assert.equal(result.terminationDate, "12/01/2078");
  }
  for (const planDate of ["-", "N/A", "unavailable"]) {
    const result = parseMemberSearchResult({ status: "Active Coverage", effectiveDate: "Dec 1,2023 - Dec 1,2078", planDate, planType: "HMO" }, row);
    assert.equal(result.coverageStatus, "active");
    assert.equal(result.effectiveDate, "12/01/2023");
    assert.equal(result.planType, "HMO");
    assert.equal(result.planDate, "");
    assert.deepEqual(result.metadata?.invalidDateFields, planDate === "unavailable" ? ["planDate"] : []);
  }
});

test("nested iframe result values wait for loading and reach the correct Excel columns", { skip: process.env.AVAILITY_BROWSER_TESTS !== "1" }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext();
    await installBrowserContextEvalHelpers(context);
    const page = await context.newPage();
    await page.setContent('<iframe></iframe>');
    const frame = page.frames()[1];
    await frame.setContent(`
      <div hidden><div>Current Plan Effective Date</div><div>Wrong hidden value</div></div>
      <span class="MuiChip-label MuiChip-labelSmall css-yfmshl">Active Coverage</span>
      <section><div><div class="MuiTypography-root MuiTypography-subtitle2 css-pep9fo">Current Plan Effective Date</div></div><div id="effective"></div></section>
      <section><div><div class="MuiTypography-root MuiTypography-subtitle2 css-pep9fo">Relationship to Subscriber</div></div><div>Self</div></section>
      <div><span class="MuiTypography-root MuiTypography-body2 css-2p8f3b">Period Start Date: </span>Sep 1,2026</div>
      <div><span class="MuiTypography-root MuiTypography-body2 css-2p8f3b">Insurance Type: </span><span>Medicaid</span></div>
      <div><span class="MuiTypography-root MuiTypography-body2 css-2p8f3b">Plan / Product: </span><div><span>HMO</span></div></div>
    `);
    assert.equal((await readMemberResponseFields(frame)).effectiveDate, "");
    await frame.evaluate(() => { setTimeout(() => { document.querySelector('#effective')!.textContent = 'Dec 1,2023 - Dec 1,2078'; }, 400); });
    const fields = await waitForMemberResponseFields(frame, 3000);
    const result = parseMemberSearchResult({ ...fields, status: await frame.locator('.MuiChip-label').innerText() }, row);
    assert.deepEqual(result.metadata?.missingFields, []);
    const input = new ExcelJS.Workbook();
    input.addWorksheet('Input').addRows([['Member ID'], ['TEST']]);
    const inputFile = new File([await input.xlsx.writeBuffer()], 'input.xlsx');
    const bytes = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: 'medrevenue' });
    const output = new ExcelJS.Workbook();
    await output.xlsx.load(new Uint8Array(bytes).buffer);
    const sheet = output.worksheets[0];
    const values: Record<string, string> = {};
    sheet.getRow(1).eachCell((cell, column) => { values[cell.text] = sheet.getRow(2).getCell(column).text; });
    for (const [column, expected] of Object.entries({ 'Coverage Status': 'active', 'Eff Date': '12/01/2023', 'End Date': '12/01/2078', 'Relationship to Subscriber': 'Self', 'Plan Date': '09/01/2026', 'Bot Insurance Type': 'Medicaid', 'Plan Type': 'HMO' })) {
      assert.equal(values[column], expected, column);
    }
    // Missing values must not consume the adjacent field's label or value.
    await frame.setContent('<section><div><div>Current Plan Effective Date</div></div><div><div>Relationship to Subscriber</div><div>Self</div></div></section>');
    assert.equal((await readMemberResponseFields(frame)).effectiveDate, '');
  } finally { await browser.close(); }
});
