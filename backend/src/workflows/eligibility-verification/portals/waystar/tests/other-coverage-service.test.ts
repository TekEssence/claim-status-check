import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";
import { extractMedRevenueUhcOtherCoverage } from "../payers/united-healthcare-all-states/medrevenue-other-coverage";
import { installBrowserEvalHelpers } from "@/backend/src/core/playwright-browser-eval-helpers";

test("Other Coverage Service Type extraction is enabled for every MedRevenue payer only", () => {
  for (const project of ["medrevenue", "minimax"] as const) {
    const config = getWaystarProjectConfig(project);
    for (const payer of ["scan", "blue-shield", "bcbs-ppo", "united-healthcare-all-states", "medicare"]) {
      assert.equal(Boolean(getWaystarPayerProjectConfig(config, payer).settings?.extractOtherCoverageServiceTypes), project === "medrevenue");
    }
  }
});

test("browser extracts vendor Service Type on either side without requiring payer or COB date", {
  skip: process.env.WAYSTAR_BROWSER_TESTS !== "1",
}, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await installBrowserEvalHelpers(page);
    const vendor = `<div class="HalfColumn"><div class="Label">Vendor</div><div class="Text">BLUE VIEW VISION</div>
      <div class="Label">Service Type</div><div class="Text">Vision (Optometry)</div></div>`;
    const other = `<div class="HalfColumn"><div class="Label">Unknown (OC)</div><div class="Text">BLUE SHIELD OF CALIFORNIA</div></div>`;
    for (const cards of [vendor + other, other + vendor]) {
      await page.setContent(`<div class="ContentContainer"><h4>Health Benefit Plan Coverage</h4><div class="HalfColumn"><div class="Label">Service Type</div><div class="Text">Wrong service</div></div></div>
        <div class="ContentContainer"><h4>OTHER COVERAGE INFORMATION</h4>${cards}</div>`);
      const blocks = await page.evaluate(extractMedRevenueUhcOtherCoverage);
      assert.deepEqual(blocks, [{ payer: "", cobDate: "", serviceType: "Vision (Optometry)" }]);
    }
    await page.setContent(`<div class="ContentContainer"><h4>Other Coverage Information</h4>${other}</div>`);
    assert.deepEqual(await page.evaluate(extractMedRevenueUhcOtherCoverage), []);
  } finally { await browser.close(); }
});
