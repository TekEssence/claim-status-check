import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { chromium } from "playwright-core";
import { installBrowserContextEvalHelpers } from "@/backend/src/core/playwright-browser-eval-helpers";
import { getAvailityProjectConfig } from "../config/projects";
import { matchingMemberIndex, parseMemberSearchResult, readMemberSearchRows, type AvailityMemberRow } from "../medrevenue/data";
import { verifyMemberSearchRow } from "../medrevenue/portal";
import { readAvailityEligibilityCredentialProfiles } from "../credentials";
import { buildWaystarOutputWorkbook } from "../../waystar/output";
import { createAvailityEligibilityRunner } from "../scraper";
import { getEligibilityPortalsForProject } from "@/frontend/src/workflows/eligibility-verification/registry";

const config = getAvailityProjectConfig("medrevenue");
const row: AvailityMemberRow = { originalIndex: 2, raw: {}, payerId: "molina", portalPayerName: "MOLINA HEALTHCARE CALIFORNIA", memberId: "001234", dateOfBirth: "01/02/1980", dateOfService: "09/11/2026", patientFirstName: "Jane", patientLastName: "Doe" };
async function file(headers: string[], rows: unknown[][]) {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet("Input");
  sheet.addRow(headers);
  rows.forEach(row => sheet.addRow(row));
  return new File([await wb.xlsx.writeBuffer()], "input.xlsx");
}
const fields = { status: "Active Coverage", effectiveDate: "Dec 1, 2023 - Dec 1, 2078", relationship: "Self", planDate: "09/01/2026", insuranceType: "Medicaid", planType: "HMO" };

test("Availity project selection retains Minimax defaults and enables MedRevenue", async () => {
  assert.deepEqual(getAvailityProjectConfig("minimax"), { id: "minimax" });
  assert.equal(config.provider, "Alkhouri, Wadie");
  assert.equal(config.providerNpi, "1568556652");
  assert.equal(config.state, "California");
  for (const project of ["minimax", "medrevenue"] as const) {
    assert.ok(getEligibilityPortalsForProject(project).some(portal => portal.id === "availity"));
    const form = new FormData();
    form.set("projectId", project);
    form.set("inputFile", new File(["test"], "input.xlsx"));
    form.set("credentialFile", new File(["test"], "login.xlsx"));
    assert.equal((await createAvailityEligibilityRunner().validateInput(form)).projectId, project);
  }
});

test("routes only configured project payers and preserves original row numbers and input IDs", async () => {
  const input = await file(["Project", "Primary Insurance Name", "Payer", "Member ID", "DOB", "DOS"], [
    ["TPM", "Molina", "BCBS", "wrong", "01/02/1980", "09/11/2026"],
    ["MedRevenue", "IEHP", "Molina", "wrong", "", ""],
    ["MedRevenue", "Molina", "IEHP", "001234", "01/02/1980", "09/11/2026"],
    ["MedRevenue", "TriZetto", "Molina", "wrong", "", ""],
  ]);
  const rows = await readMemberSearchRows(input, config);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].originalIndex, 4);
  assert.equal(rows[0].memberId, "001234");
  assert.equal(rows[0].portalPayerName, row.portalPayerName);
  const extended = { ...config, payers: { ...config.payers, example: { portalPayerName: "EXAMPLE PAYER", insuranceNameAliases: ["Example"] } } };
  assert.equal((await readMemberSearchRows(await file(["Primary Insurance Name"], [["Example"]]), extended))[0].portalPayerName, "EXAMPLE PAYER");
});

test("shared credential reader never selects Minimax credentials for MedRevenue", async () => {
  const input = await file(["Project", "Portal", "Link", "Username", "Password", "Secret Key"], [
    ["TPM", "Availity", "https://example.test", "legacy", "test", "test"],
    ["MedRevenue", "Availity", "https://example.test", "medrevenue", "test", "test"],
  ]);
  assert.equal((await readAvailityEligibilityCredentialProfiles(input, "minimax"))[0].username, "legacy");
  assert.equal((await readAvailityEligibilityCredentialProfiles(input, "medrevenue"))[0].username, "medrevenue");
});

test("member selection rejects absent, conflicting and ambiguous results", () => {
  assert.equal(matchingMemberIndex([["OTHER", "999999"], ["DOE, JANE", "001234", "01/02/1980"]], row), 1);
  assert.equal(matchingMemberIndex([["DOE, JANE", "01/02/1980"]], row), 0);
  assert.throws(() => matchingMemberIndex([["DOE, JANE"]], row), /No member/);
  assert.throws(() => matchingMemberIndex([["001234", "02/02/1980"]], row), /No member/);
  assert.throws(() => matchingMemberIndex([["001234"], ["001234"]], row), /ambiguous/);
  assert.throws(() => matchingMemberIndex([], row), /No member/);
});

test("result parsing and workbook reuse preserve MedRevenue columns and DOS", async () => {
  const result = parseMemberSearchResult(fields, row);
  assert.equal(result.effectiveDate, "12/01/2023");
  assert.equal(result.terminationDate, "12/01/2078");
  assert.equal(result.planDate, "09/01/2026");
  assert.equal(result.insuranceType, "Medicaid");
  assert.equal(result.planType, "HMO");
  assert.equal(parseMemberSearchResult({ ...fields, status: "Inactive Coverage" }, row).coverageStatus, "inactive");
  assert.throws(() => parseMemberSearchResult({ ...fields, status: "" }, row), /missing/);
  const inputFile = await file(["DOS"], [[row.dateOfService]]);
  const output = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: "medrevenue" });
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(output).buffer);
  assert.deepEqual(Array.from(wb.worksheets[0].getRow(1).values as ExcelJS.CellValue[]).slice(1), ["DOS", "Coverage Status", "Eff Date", "End Date", "Other Ins", "Other Ins Eff Date", "Relationship to Subscriber", "Plan Type", "Bot Insurance Type", "Plan Date", "Service Type"]);
  assert.equal(wb.worksheets[0].getCell("A2").text, "09/11/2026");
  assert.equal(wb.worksheets[0].getCell("C2").text, "12/01/2023");
});

test("browser member search selects the matching row, fills DOS, then submits", { skip: process.env.AVAILITY_BROWSER_TESTS !== "1" }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const context = await browser.newContext();
    await installBrowserContextEvalHelpers(context);
    const page = await context.newPage();
    const date = (label: string) => `<div class="MuiFormControl-root"><label>${label}</label><div class="MuiPickersSectionList-root">${["Month", "Day", "Year"].map(name => `<span contenteditable="true" role="spinbutton" aria-label="${name}">${name}</span>`).join("")}</div></div>`;
    await page.setContent(`<div id="patient_registration-menu">Patient Registration</div><div title="Eligibility and Benefits Inquiry">Eligibility and Benefits Inquiry</div>
      <input id="payerId-field" value="MOLINA HEALTHCARE CALIFORNIA" aria-expanded="false"><input id="provider" value="Alkhouri, Wadie" aria-expanded="false" aria-invalid="false"><button role="tab" aria-selected="true">Member Search</button>
      <div id="member-search-panel"><input name="msMemberId">${date("Date of Birth")}<input id="msStateCode"><button onclick="document.querySelector('table').hidden=false">Search</button></div>
      <table hidden><tbody><tr><td>OTHER</td><td>999999</td></tr><tr onclick="window.selected=true;document.querySelector('#dos').hidden=false;document.querySelector('#submit').disabled=false"><td>DOE, JANE</td><td>001234</td><td>01/02/1980</td></tr></tbody></table>
      <div id="dos" hidden>${date("As of Date")}</div><button id="submit" disabled>Submit</button>
      <script>
      const provider = document.querySelector('#provider');
      provider.oninput=()=>{
        document.querySelector('[role=listbox]')?.remove();
        const list=document.createElement('div');list.role='listbox';
        // Suggestions arrive asynchronously and contain both organization and individual.
        for (const [name,npi] of [['WADIE ALKHOURI MD INC','1144661653'],['Alkhouri, Wadie','1568556652']]) {
          const o=document.createElement('div');o.role='option';o.textContent=name+' (NPI: '+npi+' • Tax ID: 331121969)';
          o.onclick=()=>{window.providerNpi=npi;provider.value=name;provider.setAttribute('aria-expanded','false');list.remove()};list.append(o);
        }
        list.hidden=true;document.body.append(list);
        setTimeout(()=>{list.hidden=false;provider.setAttribute('aria-expanded','true')},150);
      };
      provider.onblur=()=>{if(!window.providerNpi)provider.value=''};
      const state=document.querySelector('#msStateCode');state.oninput=()=>{document.querySelector('[role=option]')?.remove();const o=document.createElement('div');o.role='option';o.textContent=state.value;o.onclick=()=>o.remove();document.body.append(o)};
      document.querySelector('#submit').onclick=()=>{window.submitted=window.selected;document.body.insertAdjacentHTML('beforeend','<span class="MuiChip-label">Active Coverage</span><div><div>Current Plan Effective Date</div><div>Dec 1, 2023 - Dec 1, 2078</div></div><div><div>Relationship to Subscriber</div><div>Self</div></div><div><span>Period Start Date: </span><span>09/01/2026</span></div><div><span>Insurance Type: </span><span>Medicaid</span></div><div><span>Plan / Product: </span><span>HMO</span></div>')};
      </script>`);
    const result = await verifyMemberSearchRow(page, row, config);
    assert.equal(result.effectiveDate, "12/01/2023");
    assert.equal(result.planType, "HMO");
    assert.equal(await page.locator('#provider').inputValue(), config.provider);
    assert.equal(await page.evaluate("window.providerNpi"), "1568556652");
    assert.equal(await page.locator('#msStateCode').inputValue(), "California");
    assert.equal(await page.locator('#dos [aria-label="Year"]').innerText(), "2026");
    assert.equal(await page.evaluate("window.submitted"), true);
  } finally { await browser.close(); }
});
