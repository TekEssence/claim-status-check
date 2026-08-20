import type { Locator, Page, Response } from "playwright-core";
import type { UhcEligibilityCredentials } from "./credentials";
import { generateUhcEligibilityTotp } from "./totp";

const SELECTORS = {
  username: "input#username, input[data-testid='username'], input[name='username'], input[name='email'], input[type='email']",
  usernameError: "#notificationMessage, .notification-message, [role='alert'], .alert, .error, #vr_username",
  loginContinue: "button#btnLogin, button[data-testid='btnLogin'], button:has-text('Continue'), button:has-text('Sign in')",
  password: "input#login-pwd, input[data-testid='login-pwd'], input[name='password'], input[type='password']",
  identityHeading: "h1#page-title",
  authenticatorMethod: "button#totp",
  otp: "input#totp, input[data-testid='totp'], input[name='totp'], input[autocomplete='one-time-code']",
  verify: "button#btnVerify, button[data-testid='btnVerify'], button:has-text('Verify')",
  eligibility: "[data-testid='eligibility-link']",
  invalidOtp: "text=/invalid|incorrect|expired|try again/i",
} as const;

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function findVisibleLocator(page: Page, selector: string, timeout: number): Promise<Locator> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const locator = frame.locator(selector).first();
      if (await locator.isVisible({ timeout: 250 }).catch(() => false)) return locator;
    }
    await wait(250);
  }

  const title = await page.title().catch(() => "");
  let location = page.url();
  try {
    const url = new URL(location);
    location = `${url.origin}${url.pathname}`;
  } catch {}
  throw new Error(
    `UHC login input did not become visible within ${timeout}ms. Page title: ${title || "(blank)"}. URL: ${location || "(blank)"}. Frames: ${page.frames().length}.`,
  );
}

async function visible(page: Page, selector: string, timeout: number): Promise<boolean> {
  return findVisibleLocator(page, selector, timeout).then(() => true).catch(() => false);
}

async function visibleText(page: Page, selector: string): Promise<string> {
  for (const frame of page.frames()) {
    const locators = frame.locator(selector);
    const count = await locators.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const locator = locators.nth(index);
      if (!(await locator.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const text = await locator.innerText({ timeout: 500 }).catch(() => "");
      if (text.trim()) return text.replace(/\s+/g, " ").trim();
    }
  }
  return "";
}

async function enterText(page: Page, selector: string, value: string, delay = 90): Promise<void> {
  const field = await findVisibleLocator(page, selector, 30_000);
  await field.click();
  await wait(250);
  await page.keyboard.press("Control+A");
  await wait(120);
  await page.keyboard.press("Backspace");
  await wait(180);
  await field.pressSequentially(value, { delay });
  await wait(300);
  if (await field.inputValue() !== value) {
    throw new Error("UHC login field did not retain the exact credential value after typing.");
  }
}

async function typeUsernameLikeOptum(page: Page, username: string): Promise<string> {
  const field = await findVisibleLocator(page, SELECTORS.username, 45_000);
  await field.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await field.pressSequentially(username, { delay: 80 });
  return field.inputValue({ timeout: 3_000 }).catch(() => "");
}
function watchLoginOptions(page: Page): Promise<Response | null> {
  return page.waitForResponse(
    (response) => response.url().includes("/api/v1/auth/login-options"),
    { timeout: 30_000 },
  ).catch(() => null);
}

async function responseUserExists(response: Response | null): Promise<boolean | null> {
  if (!response) return null;
  const body = await response.text().catch(() => "");
  const match = body.match(/"userExists"\s*:\s*(true|false)/i);
  return match ? match[1].toLowerCase() === "true" : null;
}

async function waitForPasswordOrNewError(
  page: Page,
  staleError: string,
  timeout = 30_000,
): Promise<{ accepted: boolean; error: string }> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await visible(page, SELECTORS.password, 500)) return { accepted: true, error: "" };
    const currentError = await visibleText(page, SELECTORS.usernameError);
    if (currentError && currentError !== staleError) return { accepted: false, error: currentError };
    await wait(300);
  }
  return { accepted: false, error: await visibleText(page, SELECTORS.usernameError) };
}

async function submitUsernameLikeOptum(page: Page, rawUsername: string): Promise<void> {
  const username = rawUsername.trim().toLowerCase();
  const staleError = await visibleText(page, SELECTORS.usernameError);
  const entered = await typeUsernameLikeOptum(page, username);
  if (entered !== username) {
    throw new Error("UHC username field mismatch. Expected " + username.length + " characters but the browser retained " + entered.length + ".");
  }

  await wait(2_000);
  const responsePromise = watchLoginOptions(page);
  await (await findVisibleLocator(page, SELECTORS.loginContinue, 10_000)).click();
  const response = await responsePromise;
  const userExists = await responseUserExists(response);

  if (userExists !== false) {
    const outcome = await waitForPasswordOrNewError(page, staleError);
    if (outcome.accepted) return;
  }

  const lastError = await visibleText(page, SELECTORS.usernameError);
  throw new Error("UHC rejected the One Healthcare ID before password entry" + (lastError ? ": " + lastError : "") + ".");
}

async function submitOtp(page: Page, secret: string): Promise<void> {
  if (!(await visible(page, SELECTORS.otp, 3_000))) {
    await findVisibleLocator(page, SELECTORS.identityHeading, 30_000);
    const authenticator = await findVisibleLocator(page, SELECTORS.authenticatorMethod, 30_000);
    await authenticator.click();
    await findVisibleLocator(page, SELECTORS.otp, 30_000);
  }

  const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (secondsRemaining < 10) await wait((secondsRemaining + 2) * 1000);
  const code = generateUhcEligibilityTotp(secret);

  await enterText(page, SELECTORS.otp, code, 80);
  await wait(650);
  await (await findVisibleLocator(page, SELECTORS.verify, 10_000)).click();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await visible(page, SELECTORS.eligibility, 500)) return;

    const invalidMessage = await visibleText(page, SELECTORS.invalidOtp);
    if (invalidMessage) {
      throw new Error("UHC explicitly rejected the authenticator code: " + invalidMessage);
    }

    const otpStillVisible = await visible(page, SELECTORS.otp, 300);
    const stillOnIdentity = page.url().includes("identity.onehealthcareid.com");
    if (!otpStillVisible && !stillOnIdentity) return;
    await wait(300);
  }

  throw new Error(
    "UHC OTP was submitted once, but the portal neither displayed an invalid-code message nor completed the post-login redirect.",
  );
}

export async function authenticateUhcEligibility(
  page: Page,
  credentials: UhcEligibilityCredentials,
): Promise<void> {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await submitUsernameLikeOptum(page, credentials.username);
  await enterText(page, SELECTORS.password, credentials.password, 80);
  await wait(650);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    findVisibleLocator(page, SELECTORS.loginContinue, 10_000).then((button) => button.click()),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  await submitOtp(page, credentials.totpSecret);
}
