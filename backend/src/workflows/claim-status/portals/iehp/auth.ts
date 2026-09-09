import type { Page } from "playwright-core";
import { IEHP_SELECTORS } from "./selectors";

export type LoginStatus = {
  status: "signed-in" | "failed" | "unknown";
  message?: string;
};

export function cleanLoginFailureMessage(message: string): string {
  return message.replace(/\s*Attempts Remaining:\s*\d+\s*$/i, "").replace(/\s+/g, " ").trim();
}

export async function detectLoginStatus(page: Page, timeoutMs: number): Promise<LoginStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const failureLocator = page.locator(IEHP_SELECTORS.auth.loginFailed).first();
    if (await failureLocator.isVisible().catch(() => false)) {
      const text = await failureLocator.innerText().catch(() => "Login ID or Password entered is incorrect. Please re-enter and try again.");
      return { status: "failed", message: cleanLoginFailureMessage(text) };
    }

    for (const selector of IEHP_SELECTORS.auth.signedInIndicators) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        return { status: "signed-in" };
      }
    }

    await page.waitForTimeout(500);
  }

  return { status: "unknown" };
}

export async function logoutIehp(page: Page, log?: (message: string) => Promise<void>): Promise<boolean> {
  const logoutSelectors = [
    "li[ng-click='logOut()']",
    ".headerTopNav_signout",
    "text=/Sign\\s*Out/i",
    "text=/Logout/i",
    "text=/Log\\s*Out/i",
  ];

  for (const selector of logoutSelectors) {
    const logoutButton = page.locator(selector).first();
    if (!(await logoutButton.isVisible().catch(() => false))) {
      continue;
    }

    await log?.("IEHP chunk complete. Logging out before restarting browser.");
    await logoutButton.click({ timeout: 5000 }).catch(async (error) => {
      throw new Error(`IEHP logout click failed for selector ${selector}: ${error instanceof Error ? error.message : String(error)}`);
    });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1000);
    return true;
  }

  await log?.("IEHP logout control was not visible before chunk browser close.");
  return false;
}
