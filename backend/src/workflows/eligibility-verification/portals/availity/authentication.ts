import type { Page } from "playwright-core";
import type { AvailityEligibilityCredentials } from "./credentials";
import { generateAvailityEligibilityTotp } from "./totp";

const LOGIN = {
  username: "input#userId[name='userId']",
  password: "input#password[name='password']",
  submit: "button:has-text('Sign In')",
};
const MFA = {
  method: "input[name='choice'][value='Authenticate me using my Authenticator app']",
  code: "input#code[name='code']",
  continue: "button:has-text('Continue')",
  invalid: "text=/invalid|not valid|incorrect|expired|try again/i",
};
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function enterText(page: Page, selector: string, value: string, delay = 90): Promise<void> {
  const field = page.locator(selector).first();
  await field.click();
  await field.fill("" );
  await field.pressSequentially(value, { delay });
  await wait(400);
}

async function isVisible(page: Page, selector: string, timeout: number): Promise<boolean> {
  return page.locator(selector).first().waitFor({ state: "visible", timeout }).then(() => true).catch(() => false);
}

async function submitMfa(page: Page, secret: string): Promise<void> {
  if (!(await isVisible(page, MFA.code, 4000))) {
    if (!(await isVisible(page, MFA.method, 4000))) {
      throw new Error("MFA screen not found. Expected authenticator method or code page.");
    }
    await page.locator(MFA.method).click();
    await page.locator(MFA.continue).click();
    await page.locator(MFA.code).waitFor({ state: "visible" });
  }
  let previousCode = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);
    if (secondsRemaining < 20) await wait((secondsRemaining + 3) * 1000);
    let code = generateAvailityEligibilityTotp(secret);
    if (code === previousCode) {
      await wait(12_000);
      code = generateAvailityEligibilityTotp(secret);
    }
    previousCode = code;
    await enterText(page, MFA.code, code, 110);
    const previousUrl = page.url();
    await page.locator(MFA.continue).click();
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (page.url() !== previousUrl) return;
      if (await isVisible(page, MFA.invalid, 500)) break;
      await wait(700);
    }
  }
  throw new Error("MFA failed after configured OTP attempts.");
}

export async function authenticateAvailityEligibility(
  page: Page,
  credentials: AvailityEligibilityCredentials,
): Promise<void> {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.locator(LOGIN.username).waitFor({ state: "visible" });
  await page.locator(LOGIN.password).waitFor({ state: "visible" });
  await enterText(page, LOGIN.username, credentials.username);
  await enterText(page, LOGIN.password, credentials.password);
  await page.locator(LOGIN.submit).click();
  await submitMfa(page, credentials.totpSecret);
  if (credentials.successUrlFragment) {
    await page.waitForURL(`**${credentials.successUrlFragment}**`, { timeout: 30_000 }).catch(() => {});
  }
}
