import type { Page } from "playwright-core";
import type { UhcEligibilityCredentials } from "./credentials";
import { generateUhcEligibilityTotp } from "./totp";

const SELECTORS = {
  username: "input#username[data-testid='username']",
  loginContinue: "button#btnLogin",
  password: "input#login-pwd[data-testid='login-pwd']",
  identityHeading: "h1#page-title",
  authenticatorMethod: "button#totp",
  otp: "input#totp[data-testid='totp']",
  verify: "button#btnVerify",
  eligibility: "[data-testid='eligibility-link']",
  invalidOtp: "text=/invalid|incorrect|expired|try again/i",
} as const;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function enterText(page: Page, selector: string, value: string): Promise<void> {
  const field = page.locator(selector).first();
  await field.waitFor({ state: "visible" });
  await field.fill("");
  await field.pressSequentially(value, { delay: 90 });
}

async function visible(page: Page, selector: string, timeout: number): Promise<boolean> {
  return page.locator(selector).first().waitFor({ state: "visible", timeout })
    .then(() => true)
    .catch(() => false);
}

async function submitOtp(page: Page, secret: string): Promise<void> {
  if (!(await visible(page, SELECTORS.otp, 3_000))) {
    await page.locator(SELECTORS.identityHeading).waitFor({ state: "visible" });
    const authenticator = page.locator(SELECTORS.authenticatorMethod).first();
    await authenticator.waitFor({ state: "visible" });
    await authenticator.click();
    await page.locator(SELECTORS.otp).waitFor({ state: "visible" });
  }

  let previousCode = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (secondsRemaining < 10) await wait((secondsRemaining + 2) * 1000);

    let code = generateUhcEligibilityTotp(secret);
    if (code === previousCode) {
      await wait(12_000);
      code = generateUhcEligibilityTotp(secret);
    }
    previousCode = code;

    await enterText(page, SELECTORS.otp, code);
    await page.locator(SELECTORS.verify).click();
    if (await visible(page, SELECTORS.eligibility, 20_000)) return;
    if (!(await visible(page, SELECTORS.invalidOtp, 1_000))) break;
  }

  throw new Error("UHC authenticator OTP verification failed after two attempts.");
}

export async function authenticateUhcEligibility(
  page: Page,
  credentials: UhcEligibilityCredentials,
): Promise<void> {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await enterText(page, SELECTORS.username, credentials.username);
  await page.locator(SELECTORS.loginContinue).click();
  await enterText(page, SELECTORS.password, credentials.password);
  await page.locator(SELECTORS.loginContinue).click();
  await submitOtp(page, credentials.totpSecret);
}
