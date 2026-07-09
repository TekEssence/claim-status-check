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
