import type { Page } from "playwright-core";
import { WAYSTAR_CLAIM_STATUS_SELECTORS } from "./selectors";

export async function openWaystarClaimSearch(page: Page): Promise<void> {
  let step = "opening Claims Processing";
  try {
    if (!/\/Claims\/ClaimSearch\/Index/i.test(page.url())) {
      const searchLink = page.locator("a#headerSearchLink[href*='/Claims/ClaimSearch/Index' i]:visible").first();
      if (!await searchLink.isVisible()) {
        // These are hover menus. Clicking their headings can close them again.
        const menu = page.locator("a:visible").filter({ hasText: /^\s*Claims Processing\s*$/i }).first();
        await menu.hover({ timeout: 30000 });
        const claims = page.locator("a[href*='/Claims/Listing/Index?appid=1' i]:visible").first();
        if (!await claims.isVisible()) {
          step = "opening Professional Claims";
          await page.locator("a:visible").filter({ hasText: /^\s*Professional Claims\s*$/i })
            .first().hover({ timeout: 30000 });
        }
        step = "opening Claims";
        await claims.click({ timeout: 30000 });
      }
      step = "opening Claim Search";
      await searchLink.click({ timeout: 30000 });
    }
    step = "waiting for the patient name and DOS search form";
    await page.locator(WAYSTAR_CLAIM_STATUS_SELECTORS.search.patientName.map((selector) => `${selector}:visible`).join(", "))
      .first().waitFor({ state: "visible", timeout: 30000 });
    const singleDos = page.locator(WAYSTAR_CLAIM_STATUS_SELECTORS.search.singleDos.map((selector) => `${selector}:visible`).join(", "));
    const fromDos = page.locator(WAYSTAR_CLAIM_STATUS_SELECTORS.search.dosFrom.map((selector) => `${selector}:visible`).join(", "));
    await singleDos.or(fromDos).first().waitFor({ state: "visible", timeout: 30000 });
    if (!await singleDos.first().isVisible()) {
      await page.locator(WAYSTAR_CLAIM_STATUS_SELECTORS.search.dosTo.map((selector) => `${selector}:visible`).join(", "))
        .first().waitFor({ state: "visible", timeout: 30000 });
    }
    await page.locator(WAYSTAR_CLAIM_STATUS_SELECTORS.search.searchButton.map((selector) => `${selector}:visible`).join(", "))
      .first().waitFor({ state: "visible", timeout: 30000 });
  } catch (error) {
    throw new Error(`Waystar failed while ${step}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
