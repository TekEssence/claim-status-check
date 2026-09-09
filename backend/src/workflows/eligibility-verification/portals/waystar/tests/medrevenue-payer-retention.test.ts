import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { matchesConfiguredWaystarPayer, verifyWaystarSelectedPayer } from "../portal";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";

const medicare = "Medicare A & B Eligibility (All States) (Z1073)";
const config = getWaystarPayerProjectConfig(getWaystarProjectConfig("medrevenue"), "medicare");
test("MedRevenue Medicare rejects CMS alias while Minimax matching is unchanged", () => {
  assert.equal(matchesConfiguredWaystarPayer("CMS(Z1073)", medicare, config), false);
  assert.equal(matchesConfiguredWaystarPayer(medicare, medicare, config), true);
  const minimax = getWaystarPayerProjectConfig(getWaystarProjectConfig("minimax"), "medicare");
  assert.equal(matchesConfiguredWaystarPayer("CMS(Z1073)", medicare, minimax), true);
  assert.equal(minimax.settings?.verifyPayerBeforeSubmit, undefined);
});
test("MedRevenue detects stale Medicare and a delayed reset after Blue Shield selection", {
  skip: process.env.WAYSTAR_BROWSER_TESTS !== "1",
}, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    const blue = "Blue Shield California(SB542)";
    await page.setContent(`<select id="Payer"><option>CMS(Z1073)</option><option>${blue}</option></select>`);
    await assert.rejects(() => verifyWaystarSelectedPayer(page, blue), /Expected Blue Shield.*found CMS/);
    await page.selectOption('#Payer', { label: blue });
    await verifyWaystarSelectedPayer(page, blue);
    await page.evaluate(() => { setTimeout(() => { (document.querySelector('#Payer') as HTMLSelectElement).selectedIndex = 0; }, 150); });
    await assert.rejects(() => verifyWaystarSelectedPayer(page, blue), /Inquiry was not submitted/);
  } finally { await browser.close(); }
});
