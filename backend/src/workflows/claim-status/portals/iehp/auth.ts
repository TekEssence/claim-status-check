import type { Locator, Page } from "playwright-core";
import { IEHP_SELECTORS } from "./selectors";

export type LoginStatus = {
  status: "signed-in" | "failed" | "otp" | "otp-rejected" | "unknown";
  message?: string;
};

export const IEHP_OTP_INPUT_NAME = "iehp_otp";
export const IEHP_OTP_TIMEOUT_MS = 6 * 60 * 1000;

type LoginDetectionOptions = { otp?: boolean; otpRejection?: boolean };

async function visibleOtpInput(page: Page): Promise<Locator | null> {
  const explicit = page.locator(IEHP_SELECTORS.auth.otpInput).first();
  if (await explicit.isVisible().catch(() => false)) return explicit;

  const prompt = page.locator(IEHP_SELECTORS.auth.otpPrompt).first();
  if (!(await prompt.isVisible().catch(() => false))) return null;
  const generic = page.locator(IEHP_SELECTORS.auth.otpGenericInput).first();
  return await generic.isVisible().catch(() => false) ? generic : null;
}

export function cleanLoginFailureMessage(message: string): string {
  return message.replace(/\s*Attempts Remaining:\s*\d+\s*$/i, "").replace(/\s+/g, " ").trim();
}

export async function detectLoginStatus(page: Page, timeoutMs: number, options: LoginDetectionOptions = {}): Promise<LoginStatus> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const failureLocator = page.locator(IEHP_SELECTORS.auth.loginFailed).first();
    if (await failureLocator.isVisible().catch(() => false)) {
      const text = await failureLocator.innerText().catch(() => "Login ID or Password entered is incorrect. Please re-enter and try again.");
      return { status: "failed", message: cleanLoginFailureMessage(text) };
    }

    if (options.otpRejection && await page.locator(IEHP_SELECTORS.auth.otpRejected).first().isVisible().catch(() => false)) {
      return { status: "otp-rejected" };
    }
    if (options.otp && await visibleOtpInput(page)) return { status: "otp" };

    for (const selector of IEHP_SELECTORS.auth.signedInIndicators) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        if (options.otpRejection && await visibleOtpInput(page)) continue;
        return { status: "signed-in" };
      }
    }

    if (Date.now() >= deadline) break;
    await page.waitForTimeout(500);
  }

  return { status: "unknown" };
}

export async function completeIehpLoginAfterCredentials(
  page: Page,
  waitForInput: (inputName: string, timeoutMs: number) => Promise<string>,
  emit: (event: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const loginOutcome = await detectLoginStatus(page, 15000, { otp: true });
  if (loginOutcome.status === "failed") throw new Error(`Login failed: ${loginOutcome.message}`);
  if (loginOutcome.status === "signed-in") return;
  if (loginOutcome.status !== "otp") {
    throw new Error("Login verification failed: could not find Sign Out, Eligibility, Welcome, or My account after submitting credentials.");
  }

  // Register the waiter before publishing the request so an immediate reply is not lost.
  const inputPromise = waitForInput(IEHP_OTP_INPUT_NAME, IEHP_OTP_TIMEOUT_MS);
  try {
    await emit({
      type: "input_request",
      inputName: IEHP_OTP_INPUT_NAME,
      label: "IEHP verification code",
      message: "Enter the IEHP verification code within 6 minutes.",
      timeoutMs: IEHP_OTP_TIMEOUT_MS,
    });
  } catch (error) {
    void inputPromise.catch(() => {});
    throw error;
  }

  let otp: string;
  try {
    otp = await inputPromise;
  } catch (error) {
    if (error instanceof Error && /OTP was not sent within/i.test(error.message)) {
      throw new Error("IEHP OTP timed out after 6 minutes.");
    }
    throw error;
  }
  if (!otp.trim()) throw new Error("IEHP OTP was empty.");

  const input = await visibleOtpInput(page);
  if (!input) throw new Error("IEHP OTP field disappeared before the code could be submitted.");
  try {
    await input.fill(otp.trim());
    const submit = page.locator(IEHP_SELECTORS.auth.otpSubmit).first();
    if (await submit.isVisible().catch(() => false)) await submit.click();
    else await input.press("Enter");
  } catch {
    throw new Error("IEHP OTP could not be submitted.");
  }

  const verified = await detectLoginStatus(page, 15000, { otpRejection: true });
  if (verified.status === "signed-in") return;
  if (verified.status === "otp-rejected") throw new Error("IEHP OTP was invalid or expired.");
  if (verified.status === "failed") throw new Error("IEHP OTP verification failed.");
  throw new Error("IEHP OTP verification did not reach a signed-in page.");
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
