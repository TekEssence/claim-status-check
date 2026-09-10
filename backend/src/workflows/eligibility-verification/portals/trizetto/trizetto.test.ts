import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { chromium } from "playwright-core";
import { matchTriZettoPayer, readTriZettoInput, readTriZettoCredentials, buildTriZettoOutput } from "./data";
import { createTriZettoEligibilityRunner } from "./scraper";
import { coverageStatus, extractTriZettoResult, loginTriZetto, submitTriZettoCode, verifyTriZettoRow, selectors } from "./portal";
import { getEligibilityPortalsForProject } from "@/frontend/src/workflows/eligibility-verification/registry";
import type { EligibilityResult } from "../../types";
import { createScrapeJob, submitScrapeJobInput } from "@/backend/src/jobs/job-store";

async function workbookFile(rows: unknown[][]) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Input").addRows(rows);
  return new File([new Uint8Array(await workbook.xlsx.writeBuffer())], "test.xlsx");
}

test("TriZetto is visible and accepted only for MedRevenu", async () => {
  assert.equal(getEligibilityPortalsForProject("minimax").some((portal) => portal.id === "trizetto"), false);
  assert.equal(getEligibilityPortalsForProject("medrevenue").some((portal) => portal.id === "trizetto"), true);
  const form = new FormData();
  form.set("projectId", "minimax");
  assert.throws(() => createTriZettoEligibilityRunner().validateInput(form), /only for MedRevenu/);
  form.set("projectId", "MedRevenu");
  form.set("inputFile", new File(["test"], "input.xlsx"));
  form.set("credentialFile", new File(["test"], "credentials.xlsx"));
  assert.equal(createTriZettoEligibilityRunner().validateInput(form).projectId, "medrevenue");
});

test("exact payer matching preserves plan qualifiers and rejects ambiguous IDs", () => {
  const payers = [{ name: "Aetna", id: "60054", index: 0 }, { name: "Aetna", id: "60054", index: 1 },
    { name: "Aetna Medicare", id: "OTHER", index: 2 }, { name: "Blue Cross California", id: "47198", index: 3 }];
  assert.equal(matchTriZettoPayer(" aETna ", payers).id, "60054");
  assert.equal(matchTriZettoPayer("Blue  Cross California", payers).id, "47198");
  assert.throws(() => matchTriZettoPayer("Blue Cross", payers), /not found/);
  assert.throws(() => matchTriZettoPayer("Aetna PPO", payers), /not found/);
  assert.throws(() => matchTriZettoPayer("", payers), /missing/);
  assert.throws(() => matchTriZettoPayer("Aetna", [...payers, { name: "Aetna", id: "DIFFERENT", index: 4 }]), /Ambiguous/);
});

test("input preserves row indexes, primary insurance IDs and MedRevenu isolation", async () => {
  const file = await workbookFile([
    ["Project", "Patient Name", "Primary Insurance Name", "Primary Insurance ID#", "Member ID", "DOB", "DOS"],
    ["MedRevenu", "SMITH, JANE", "Aetna", "001234", "wrong", "01/01/1990", "09/09/2026"],
    [], ["Minimax", "DOE, JOHN", "Aetna", "999", "", "01/01/1990", "09/09/2026"],
    ["MedRevenue", "DOE, JANE", "Missing Payer", "000002", "", "01/01/1990", "09/09/2026"],
  ]);
  const rows = await readTriZettoInput(file);
  assert.deepEqual(rows.map((row) => row.originalIndex), [2, 5]);
  assert.equal(rows[0].subscriberId, "001234");
  assert.equal(rows[0].patientLastName, "SMITH");
  const result: EligibilityResult = { rowIndex: 2, payerId: "trizetto:60054", coverageStatus: "active", patientName: "LISA M SORIANO", effectiveDate: "01/01/2026", planDate: "01/01/2025", relationshipToSubscriber: "Self", benefits: [], metadata: { medRevenueOutputServiceType: "Health Benefit Plan Coverage", trizettoDescription: "Open Access Plus" } };
  const buffer = await buildTriZettoOutput({ inputFile: file, rows: new Map(rows.map((row) => [row.originalIndex, row])), results: new Map([[2, result]]), errors: new Map([[5, "TriZetto payer not found"]]) });
  const output = new ExcelJS.Workbook();
  await output.xlsx.load(new Uint8Array(buffer).buffer);
  const sheet = output.worksheets[0];
  const headers = (sheet.getRow(1).values as string[]).slice(8);
  assert.deepEqual(headers, ["Coverage Status", "Eff Date", "End Date", "Other Ins", "Other Ins Eff Date", "Relationship to Subscriber", "Plan Type", "Bot Insurance Type", "Plan Date", "Service Type", "Description"]);
  assert.equal(sheet.getCell(2, 18).text, "Open Access Plus");
  assert.equal(sheet.getCell(5, 18).text, "TriZetto payer not found");
  assert.equal(sheet.getCell(5, 8).text, "error");
  assert.equal(sheet.getCell(2, 2).text, "LISA M SORIANO");
  assert.equal(sheet.getCell(5, 2).text, "DOE, JANE");
  assert.equal(sheet.getCell(4, 8).text, "");
});

test("credentials reject other projects and portals", async () => {
  const wrongProject = await workbookFile([["Project", "Portal", "Username", "Password", "Link"], ["Minimax", "TriZetto", "wrong", "password", "https://example.test"]]);
  await assert.rejects(() => readTriZettoCredentials(wrongProject), /exactly one/);
  const file = await workbookFile([["Project", "Portal", "Username", "Password", "Link"],
    ["Minimax", "TriZetto", "wrong", "password", "https://example.test"],
    ["MedRevenu", "Waystar", "wrong", "password", "https://example.test"],
    ["MedRevenu", "TriZetto", "right", "password", "https://example.test"]]);
  assert.equal((await readTriZettoCredentials(file)).username, "right");
});

test("inactive and unknown responses are never reported active", () => {
  assert.equal(coverageStatus("Inactive Coverage"), "inactive");
  assert.equal(coverageStatus("No Active Coverage"), "inactive");
  assert.equal(coverageStatus("Active Coverage"), "active");
  assert.equal(coverageStatus("Unable to determine eligibility"), "unknown");
});

test("browser handles hidden payer categories, validation failure, then a clean response", {
  skip: process.env.TRIZETTO_BROWSER_TESTS !== "1",
}, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    const fields = [selectors.dos, selectors.dosEnd, selectors.subscriberId, selectors.firstName, selectors.lastName, selectors.dob].map((selector) => `<input id="${selector.slice(1)}">`).join("");
    await page.route("https://trizetto.test/inquiry", (route) => route.fulfill({ contentType: "text/html", body: `
      <ul id="Insurers"><li><a class="payer-category" onclick="this.nextElementSibling.style.display='block'">Commercial</a>
      <ul style="display:none"><li class="payer-row"><a class="payer-selection">Aetna</a><div class="payer-selection-id">60054</div></li></ul></li></ul>
      ${fields}<span onclick="if(document.getElementById('${selectors.subscriberId.slice(1)}').value==='bad') document.getElementById('errors').textContent='Invalid subscriber ID'; else document.getElementById('response').style.display='block'">Submit&nbsp;Eligibility&nbsp;Inquiry</span>
      <div id="errors" class="validation-summary-errors"></div><div id="response" style="display:none">
      <table><tr><td>HtmlRender Cigna Submitted By<table><tr><th>Service Type</th><th>Description</th></tr><tr><td>Wrong service</td><td>Wrong description</td></tr></table><h1 id="trnEligibilityStatus">Active Coverage</h1><dl><dt>Plan Begin Date:</dt><dd>01/01/2025</dd><dt>Eligibility Begin Date:</dt><dd>01/01/2026</dd></dl>
      <strong class="childtab">Patient Information</strong><div id="nadName">LISA M SORIANO</div><dl><dt>Relationship to insured</dt><dd>Self</dd></dl>
      <strong class="childtab">Benefit Information</strong><a class="sections">Active Coverage</a>
      <div><table><tr><th>Service Type</th></tr><tr><td>Health Benefit Plan Coverage</td></tr></table><table><tr><th>Description</th></tr><tr><td>Open Access Plus</td></tr><tr><td>Open Access Plus</td></tr></table></div><a class="sections">Other Benefits</a><table><tr><th>Service Type</th><th>Description</th></tr><tr><td>Wrong other service</td><td>Wrong other description</td></tr></table></td></tr></table></div>` }));
    const row = { originalIndex: 2, subscriberId: "bad", patientFirstName: "Jane", patientLastName: "Doe", dateOfBirth: "1990-01-01", dateOfService: "2026-09-09", raw: { "Primary Insurance Name": "Aetna" } };
    await assert.rejects(() => verifyTriZettoRow(page, "https://trizetto.test/inquiry", row), /Invalid subscriber ID/);
    await assert.rejects(() => verifyTriZettoRow(page, "https://trizetto.test/inquiry", { ...row, raw: { "Primary Insurance Name": "Aetna PPO" } }), /payer not found/);
    const result = await verifyTriZettoRow(page, "https://trizetto.test/inquiry", { ...row, originalIndex: 4, subscriberId: "001234" });
    assert.equal(result.coverageStatus, "active");
    assert.equal(result.planDate, "01/01/2025");
    assert.equal(result.effectiveDate, "01/01/2026");
    assert.equal(result.relationshipToSubscriber, "Self");
    assert.equal(result.patientName, "LISA M SORIANO");
    assert.equal(result.metadata?.medRevenueOutputServiceType, "Health Benefit Plan Coverage");
    assert.equal(result.metadata?.trizettoDescription, "Open Access Plus");
    await page.getByText("Open Access Plus", { exact: true }).evaluateAll((cells) => cells.forEach((cell) => { cell.textContent = "LocalPlus"; }));
    const localPlus = await extractTriZettoResult(page, 4, "60054");
    assert.equal(localPlus.metadata?.trizettoDescription, "LocalPlus");
    assert.equal(localPlus.metadata?.medRevenueOutputServiceType, "Health Benefit Plan Coverage");
    assert.equal(await page.locator(selectors.dosEnd).inputValue(), "09/09/2026");
    assert.equal(await page.locator(selectors.subscriberId).inputValue(), "001234");
  } finally { await browser.close(); }
});

test("login clicks the visible Email cell for either domain without selecting Text", {
  skip: process.env.TRIZETTO_BROWSER_TESTS !== "1",
}, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    for (const domain of ["medrevenu.com", "opusbpo.com"]) {
      await page.route("https://trizetto.test/login", (route) => route.fulfill({ contentType: "text/html", body: `
        <input id="UserName"><input id="Password" type="password"><input id="login-button" type="submit" value="Log In" onclick="document.getElementById('mfa').style.display='block'">
        <table style="display:none"><tr><td>Email XXXXiams@old.example</td></tr></table>
        <table id="mfa" style="display:none"><tr onclick="window.selectedMethod='email'; document.getElementById('home').style.display='block'; this.parentElement.parentElement.style.display='none'">
        <td style="text-align:left">\n Email XXXXiams@${domain}\n </td></tr>
        <tr onclick="window.selectedMethod='text'"><td>Text XXX-XXX-5156</td></tr></table>
        <div id="home" style="display:none"><a id="NavCtrl_navManagePatients">Manage Patients</a><a id="NavCtrl_hlEligibility">Check Patient Eligibility</a>
        <a class="toggleLink" href="/ManagePatients/RealTimeEligibility/Index" onclick="event.preventDefault()">Run Individual Eligibility Inquiry</a><ul id="Insurers"><li class="payer-row">Aetna</li></ul></div>` }));
      const logs: string[] = [];
      await loginTriZetto(page, { loginUrl: "https://trizetto.test/login", username: "test", password: "test" }, {
        jobId: "test", workflowId: "eligibility-verification", portalId: "trizetto", log: async (event) => { logs.push(event.eventName ?? ""); }, emit: async () => {},
      });
      assert.equal(await page.evaluate("window.selectedMethod"), "email");
      assert.ok(logs.includes("eligibility_trizetto_email_selected"));
      await page.unroute("https://trizetto.test/login");
    }
  } finally { await browser.close(); }
});

test("headless login requests frontend OTP for a placeholder-only Code field and submits it", {
  skip: process.env.TRIZETTO_BROWSER_TESTS !== "1",
}, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const job = createScrapeJob(undefined, "eligibility-verification");
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await page.route("https://trizetto.test/login", (route) => route.fulfill({ contentType: "text/html", body: `
      <input id="UserName"><input id="Password" type="password"><button id="login-button" onclick="document.getElementById('email').style.display='block'">Log In</button>
      <table id="email" style="display:none"><tr><td onclick="document.getElementById('codeForm').style.display='block'; document.getElementById('email').style.display='none'">Email XXXXiams@opusbpo.com</td></tr></table>
      <div id="codeForm" style="display:none"><p>Please enter the code to sign in.</p><input placeholder="Code" onkeyup="window.codeKeyups=(window.codeKeyups||0)+1" onblur="document.getElementById('btnVerify').disabled=!(window.codeKeyups>=6 && this.value.length===6)"><input type="checkbox">Remember this browser
      <input id="btnVerify" type="submit" value="Verify" disabled onclick="window.submittedCode=document.querySelector('[placeholder=Code]').value; document.getElementById('home').style.display='block'; document.getElementById('codeForm').style.display='none'"></div>
      <div id="home" style="display:none"><a id="NavCtrl_navManagePatients">Manage Patients</a><a id="NavCtrl_hlEligibility">Check Patient Eligibility</a>
      <a class="toggleLink" href="/ManagePatients/RealTimeEligibility/Index" onclick="event.preventDefault()">Run Individual Eligibility Inquiry</a><ul id="Insurers"><li class="payer-row">Aetna</li></ul></div>` }));
    let requestCount = 0;
    let accepted = false;
    await loginTriZetto(page, { loginUrl: "https://trizetto.test/login", username: "test", password: "test" }, {
      jobId: job.id, workflowId: "eligibility-verification", portalId: "trizetto", log: async () => {},
      emit: async (event) => {
        if (event.type !== "otp_request") return;
        requestCount++;
        assert.equal(event.label, "TriZetto email verification code");
        assert.match(String(event.message), /Submit code/);
        assert.equal(await page.getByPlaceholder("Code", { exact: true }).inputValue(), "");
        // Simulate the frontend's job-input submission after receiving the event.
        setImmediate(() => { accepted = submitScrapeJobInput(job.id, String(event.inputName), " 012345 "); });
      },
    });
    assert.equal(requestCount, 1);
    assert.equal(accepted, true);
    assert.equal(await page.evaluate("window.submittedCode"), "012345");
    assert.ok(Number(await page.evaluate("window.codeKeyups")) >= 6);
    assert.equal(job.inputWaiters.size, 0);
  } finally {
    for (const [inputName] of job.inputWaiters) submitScrapeJobInput(job.id, inputName, "");
    await browser.close();
  }
});

test("code entry reports a disabled Verify without bypassing portal validation", {
  skip: process.env.TRIZETTO_BROWSER_TESTS !== "1",
}, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent('<input placeholder="Code"><input id="btnVerify" type="submit" value="Verify" disabled onclick="window.clicked=true">');
    await assert.rejects(() => submitTriZettoCode(page, page.getByPlaceholder("Code"), "012345", 100), /kept Verify disabled/);
    assert.equal(await page.locator("#btnVerify").isDisabled(), true);
    assert.equal(await page.evaluate("window.clicked"), undefined);
  } finally { await browser.close(); }
});
