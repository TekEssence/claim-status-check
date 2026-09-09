import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { repairMedRevenueAetnaUmrPatientFields } from "../portal";

test("Aetna/UMR repairs ID cleared by DOB without retriggering retained patient fields", {
  skip: process.env.WAYSTAR_BROWSER_TESTS !== "1",
}, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(`<input id="SbrId" value="TEST123">
      <input id="LName" value="TEST"><input id="FName" value="PATIENT">
      <input id="DOB" onblur="document.querySelector('#SbrId').value = ''; window.blurs = (window.blurs || 0) + 1">`);
    await repairMedRevenueAetnaUmrPatientFields(page, {
      memberId: "TEST123", lastName: "TEST", firstName: "PATIENT", dateOfBirth: "01/01/1990",
    });
    assert.equal(await page.locator('#SbrId').inputValue(), "TEST123");
    assert.equal(await page.evaluate('window.blurs'), 1);
    // Cigna can arrive at final validation with a cleared ID and retained DOB.
    await page.setContent(`<input id="SbrId"><input id="LName" value="TEST"><input id="FName" value="PATIENT">
      <input id="DOB" value="01/01/1990" onblur="document.querySelector('#SbrId').value = ''">`);
    await repairMedRevenueAetnaUmrPatientFields(page, {
      memberId: "CIGNA123", lastName: "TEST", firstName: "PATIENT", dateOfBirth: "01/01/1990",
    }, "Cigna");
    assert.equal(await page.locator('#SbrId').inputValue(), "CIGNA123");
    assert.equal(await page.locator('#DOB').inputValue(), "01/01/1990");
    await page.setContent(`<input id="SbrId" onblur="setTimeout(() => this.value = '', 100)">
      <input id="LName" value="TEST"><input id="FName" value="PATIENT"><input id="DOB" value="01/01/1990">`);
    await assert.rejects(() => repairMedRevenueAetnaUmrPatientFields(page, {
      memberId: "TEST123", lastName: "TEST", firstName: "PATIENT", dateOfBirth: "01/01/1990",
    }), /three repair attempts/);
  } finally { await browser.close(); }
});
