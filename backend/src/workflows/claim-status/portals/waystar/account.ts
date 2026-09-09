import type { Page } from "playwright-core";

export const WAYSTAR_CLAIM_ACCOUNT = "MedRevenu LLC (86750)";
const HEADER = "input.header-account-search-text:visible";
const ACCOUNT_PATTERN = /^\s*MedRevenu\s+LLC\s*\(86750\)\s*$/i;

export async function ensureWaystarClaimAccount(page: Page): Promise<void> {
  try {
    const header = page.locator(HEADER).first();
    await header.waitFor({ state: "visible", timeout: 60000 });
    if (ACCOUNT_PATTERN.test(await header.inputValue())) return;

    await page.locator("#hdrAcctChildSearchLnk").click();
    await page.locator("#accountSearchChildModal .header-account-search-input").first().fill("86750");
    await page.locator("#accountSearchChildButton").click();
    // Select the actual account link; editing the header value does not switch the session.
    const account = page.locator("#accountSearchChildModal a.change-account-link:visible")
      .filter({ hasText: ACCOUNT_PATTERN });
    await account.waitFor({ state: "visible", timeout: 30000 });
    await account.click();
    // Read rendered text across nested labels/spans and wait for both the
    // confirmation and updated header. A typed header alone is not success.
    await page.waitForFunction(() => {
      const expected = /^\s*MedRevenu\s+LLC\s*\(86750\)\s*$/i;
      const headers = Array.from(document.querySelectorAll<HTMLInputElement>("input.header-account-search-text"));
      const activeHeader = headers.find((element) => element.getClientRects().length > 0);
      const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
      return Boolean(activeHeader && expected.test(activeHeader.value)
        && /You have switched to the following account\s*:/i.test(text)
        && /Account\s*:\s*MedRevenu\s+LLC\s*\(86750\)/i.test(text));
    }, undefined, { timeout: 30000 });
  } catch (error) {
    throw new Error(`Waystar claim status requires ${WAYSTAR_CLAIM_ACCOUNT}. Account selection could not be confirmed; claim search was stopped. ${error instanceof Error ? error.message : String(error)}`);
  }
}
