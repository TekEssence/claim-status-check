import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";
import { findMedRevenuePatientLookupOption, restoreMedRevenuePatientLookup, fillPlanDatesFromDateOfService, repairWaystarMemberIdAndDob } from "../portal";

test("MedRevenue lookup uses payer option labels instead of assuming numeric lookup IDs", () => {
  const options = [
    { value: "10", label: "Sbr ID" },
    { value: "42", label: "Sbr ID, DOB" },
    { value: "83", label: "Sbr ID, LName, FName, DOB" },
  ];
  assert.equal(findMedRevenuePatientLookupOption(options, true)?.value, "42");
  assert.equal(findMedRevenuePatientLookupOption(options, false)?.value, "83");
  assert.equal(findMedRevenuePatientLookupOption(options.slice(0, 1), false), null);
});

test("form recovery is scoped to affected MedRevenue payers", () => {
  for (const project of ["minimax", "medrevenue"] as const) {
    for (const payer of ["scan", "blue-shield", "bcbs-ppo", "united-healthcare-all-states", "medicare", "aetna"]) {
      const config = getWaystarPayerProjectConfig(getWaystarProjectConfig(project), payer);
      assert.equal(Boolean(config.retryPlanDatesWithKeyboard), project === "medrevenue" && payer === "umr");
      assert.equal(Boolean(config.repairPatientValueReset), project === "medrevenue" && payer === "blue-shield");
      assert.equal(Boolean(config.restorePatientLookup), project === "medrevenue" && ["scan", "blue-shield", "bcbs-ppo", "united-healthcare-all-states", "aetna", "umr"].includes(payer));
    }
  }
  const scan = getWaystarProjectConfig("medrevenue").payers!.scan;
  assert.equal(scan.skipProviderHandling, true);
  assert.equal(scan.requireExactPayerSuggestionCommit, true);
});

test("browser restores hidden demographics and fills single or dual Plan Date forms", {
  skip: process.env.WAYSTAR_BROWSER_TESTS !== "1",
}, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.setContent(`<select id="PatientLookup" onchange="document.querySelectorAll('input').forEach(i => i.style.display = this.value === '83' || (this.value === '42' && !['LName','FName'].includes(i.id)) ? '' : 'none')">
      <option value="0">Select</option><option value="42">Sbr ID, DOB</option><option value="83">Sbr ID, LName, FName, DOB</option></select>
      <input id="SbrId" style="display:none"><input id="DOB" style="display:none"><input id="LName" style="display:none"><input id="FName" style="display:none">`);
    await restoreMedRevenuePatientLookup(page, true);
    assert.equal(await page.locator('#PatientLookup').inputValue(), '42');
    assert.equal(await page.locator('#LName').isVisible(), false);
    await restoreMedRevenuePatientLookup(page, false);
    assert.equal(await page.locator('#PatientLookup').inputValue(), '83');
    assert.equal(await page.locator('#LName').isVisible(), true);
    await page.setContent(`<input id="SbrId" value="XTEST123"><input id="DOB"
      onblur="document.querySelector('#SbrId').value = ''; window.dobBlurs = (window.dobBlurs || 0) + 1">`);
    await repairWaystarMemberIdAndDob(page, 'XTEST123', '01/01/1990');
    assert.equal(await page.locator('#SbrId').inputValue(), 'XTEST123');
    assert.equal(await page.locator('#DOB').inputValue(), '01/01/1990');
    assert.equal(await page.evaluate('window.dobBlurs'), 1, 'retained DOB must not be refilled and clear ID again');
    await page.setContent(`<input id="SbrId" onblur="setTimeout(() => this.value = '', 200)"><input id="DOB" value="01/01/1990">`);
    await assert.rejects(() => repairWaystarMemberIdAndDob(page, 'XTEST123', '01/01/1990'), /three repair attempts: Member ID was cleared/);
    await page.setContent(`<input id="txtPlanFrom"><input id="txtPlanTo" onkeydown="this.dataset.typed='yes'" onchange="if (!this.dataset.typed) this.value=''">`);
    await fillPlanDatesFromDateOfService(page, '08/14/2026', getWaystarProjectConfig('medrevenue').payers!.umr);
    assert.equal(await page.locator('#txtPlanFrom').inputValue(), '08/14/2026');
    assert.equal(await page.locator('#txtPlanTo').inputValue(), '08/14/2026');
    for (const payer of ['scan', 'blue-shield', 'bcbs-ppo', 'united-healthcare-all-states', 'umr', 'aetna']) {
      const config = getWaystarProjectConfig('medrevenue').payers![payer];
      for (const end of ['', '<input id="txtPlanTo">', '<input id="txtPlanTo" style="display:none">']) {
        await page.setContent(`<input id="txtPlanFrom">${end}`);
        await fillPlanDatesFromDateOfService(page, '09/07/2026', config);
        assert.equal(await page.locator('#txtPlanFrom').inputValue(), '09/07/2026');
        if (end && await page.locator('#txtPlanTo').isVisible()) assert.equal(await page.locator('#txtPlanTo').inputValue(), '09/07/2026');
        if (end.includes('display:none')) assert.equal(await page.locator('#txtPlanTo').inputValue(), '');
      }
      await assert.rejects(() => fillPlanDatesFromDateOfService(page, '', config), /DOS is missing/);
    }
  } finally {
    await browser.close();
  }
});
