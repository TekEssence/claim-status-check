import type { Page } from "playwright-core";
import { blueShieldConfig } from "./config";
import { assertNoSecurityBlock } from "./detection-monitor";
import { waitForBlueShieldOtp } from "./otp-service";
import type { BlueShieldCredentials } from "./types";

async function firstVisible(page: Page, selector: string) {
  const locator = page.locator(selector).first();
  return (await locator.count()) > 0 && await locator.isVisible().catch(() => false) ? locator : null;
}

async function waitForVisible(page: Page, selector: string, timeout = 10000) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout }).catch(() => {});
  return firstVisible(page, selector);
}

async function clickIfVisible(page: Page, selector: string, timeout = 3000): Promise<boolean> {
  const locator = await waitForVisible(page, selector, timeout);
  if (!locator) return false;
  await locator.click().catch(async (error) => {
    if (/onetrust|intercepts pointer events/i.test(error instanceof Error ? error.message : String(error))) {
      await handleCookieConsent(page, async () => {});
    }
    await locator.click({ timeout: 5000 });
  });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await assertNoSecurityBlock(page);
  return true;
}

async function typeLoginField(page: Page, selector: string, value: string): Promise<void> {
  const field = await waitForVisible(page, selector, 10000);
  if (!field) {
    throw new Error(`Blue Shield login field was not found: ${selector}`);
  }

  await field.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type(value, { delay: 20 });
  await field.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
  });
}

async function clickBlueShieldLoginSubmit(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const button = document.querySelector("#signOnButton");
    return button && !button.hasAttribute("disabled");
  }, null, { timeout: 10000 }).catch(() => {});

  const disabled = await page.locator("#signOnButton").first().getAttribute("disabled").catch(() => null);
  if (disabled != null) {
    throw new Error("Blue Shield login button is still disabled after entering username and password.");
  }

  await page.locator("#signOnButton").first().click({ timeout: 5000 }).catch(async () => {
    await page.locator("#signOnButton").first().click({ force: true, timeout: 5000 });
  });
}

async function handleCookieConsent(page: Page, log: (message: string) => Promise<void>): Promise<void> {
  const selectors = blueShieldConfig.selectors;
  const activeCookieCount = await page.locator([
    "#onetrust-accept-btn-handler:visible",
    "#onetrust-reject-all-handler:visible",
    "#onetrust-overlay:visible",
    "#onetrust-banner-sdk:visible",
    "#onetrust-consent-sdk .onetrust-pc-dark-filter:visible",
    "#onetrust-consent-sdk .onetrust-first-para:visible",
  ].join(", ")).count().catch(() => 0);
  if (activeCookieCount === 0) {
    return;
  }

  const clickedCookieButton = await page.evaluate(() => {
    const root = document.querySelector("#onetrust-consent-sdk");
    if (!root) return "";

    const isUsable = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };

    const controls = Array.from(root.querySelectorAll("button, a, input[type='button'], input[type='submit'], [role='button']"));
    const wanted = controls.find((control) => {
      const text = `${control.textContent ?? ""} ${(control as HTMLInputElement).value ?? ""}`.trim().toLowerCase();
      return isUsable(control) && /^(continue|accept|accept all|i agree|agree)$/i.test(text);
    });

    if (wanted instanceof HTMLElement) {
      wanted.scrollIntoView({ block: "center", inline: "nearest" });
      wanted.click();
      return (wanted.textContent || (wanted as HTMLInputElement).value || "cookie control").trim();
    }

    return "";
  }).catch(() => "");

  if (clickedCookieButton) {
    await page.locator("#onetrust-consent-sdk .onetrust-pc-dark-filter").first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await page.locator("#onetrust-overlay").first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
    await log(`Blue Shield cookie banner clicked: ${clickedCookieButton}.`);
    return;
  }

  await page.evaluate((selector) => {
    const containers = Array.from(document.querySelectorAll(selector));
    for (const container of containers) {
      container.scrollTop = container.scrollHeight;
      container.scrollIntoView({ block: "end", inline: "nearest" });
    }
    window.scrollTo(0, document.body.scrollHeight);
  }, selectors.cookieScrollContainer).catch(() => {});
  await page.waitForTimeout(300);

  const acceptButtons = page.locator(selectors.cookieAccept);
  const acceptCount = await acceptButtons.count().catch(() => 0);
  for (let index = 0; index < acceptCount; index++) {
    const accept = acceptButtons.nth(index);
    await accept.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    if (await accept.isVisible().catch(() => false)) {
      await accept.click({ timeout: 5000 }).catch(async () => {
        await accept.click({ force: true, timeout: 5000 });
      });
      await page.waitForTimeout(500);
      await page.locator("#onetrust-overlay").first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
      await log("Blue Shield cookie banner continued/accepted.");
      return;
    }
  }

  const close = page.locator(selectors.cookieClose).first();
  if (await close.isVisible().catch(() => false)) {
    await close.click();
    await page.waitForTimeout(500);
    await log("Blue Shield cookie banner closed.");
    return;
  }

  const removedOverlay = await page.evaluate(() => {
    const selectorsToHide = [
      "#onetrust-overlay",
      "#onetrust-banner-sdk",
      "#onetrust-pc-sdk",
      "#onetrust-consent-sdk .onetrust-pc-dark-filter",
    ];
    let removed = false;
    for (const selector of selectorsToHide) {
      for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
        element.style.setProperty("display", "none", "important");
        element.style.setProperty("visibility", "hidden", "important");
        element.style.setProperty("pointer-events", "none", "important");
        removed = true;
      }
    }
    document.body.classList.remove("modal-open");
    document.documentElement.style.removeProperty("overflow");
    document.body.style.removeProperty("overflow");
    return removed;
  }).catch(() => false);

  if (removedOverlay) {
    await page.waitForTimeout(300);
    await log("Blue Shield cookie overlay was hidden after normal controls were unavailable.");
  }
}

async function handleOptionalBookmarkPage(page: Page, log: (message: string) => Promise<void>): Promise<boolean> {
  await handleCookieConsent(page, log);
  if (await clickIfVisible(page, blueShieldConfig.selectors.bookmarkProvider, 3000)) {
    await log("Blue Shield bookmark page detected. Continued to Provider page.");
    return true;
  }
  return false;
}

async function waitForManualOtpCompletion(page: Page, log: (message: string) => Promise<void>): Promise<void> {
  await log("Blue Shield OTP page detected. Please enter the OTP manually in the visible browser.");
  await Promise.race([
    page.locator(blueShieldConfig.selectors.otpInput).first().waitFor({ state: "hidden", timeout: 300000 }).catch(() => {}),
    page.locator(blueShieldConfig.selectors.otpContinue).first().waitFor({ state: "visible", timeout: 300000 }).catch(() => {}),
    page.locator(blueShieldConfig.selectors.bookmarkProvider).first().waitFor({ state: "visible", timeout: 300000 }).catch(() => {}),
    page.locator(blueShieldConfig.selectors.hamburgerMenu).first().waitFor({ state: "visible", timeout: 300000 }).catch(() => {}),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await assertNoSecurityBlock(page);
  await log("Manual Blue Shield OTP step completed or timed out; continuing.");
}

export async function loginToBlueShield(options: {
  page: Page;
  credentials: BlueShieldCredentials;
  log: (message: string) => Promise<void>;
}): Promise<void> {
  const { page, credentials, log } = options;
  const selectors = blueShieldConfig.selectors;

  await log(`Opening Blue Shield login URL: ${credentials.loginUrl}`);
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await assertNoSecurityBlock(page);
  await handleCookieConsent(page, log);
  const startedFromBookmarkPage = await handleOptionalBookmarkPage(page, log);

  await handleCookieConsent(page, log);
  await clickIfVisible(page, selectors.loginRegister, 5000);

  if (!await waitForVisible(page, selectors.password, 10000)) {
    if (startedFromBookmarkPage) {
      await clickIfVisible(page, selectors.loginRegister, 5000);
    }
  }

  if (!await waitForVisible(page, selectors.password, 10000)) {
    await log("Blue Shield session appears to be already authenticated.");
    await handleOptionalBookmarkPage(page, log);
    return;
  }

  await typeLoginField(page, selectors.username, credentials.username);
  await typeLoginField(page, selectors.password, credentials.password);
  await handleCookieConsent(page, log);
  await clickBlueShieldLoginSubmit(page);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await assertNoSecurityBlock(page);
  if (await handleOptionalBookmarkPage(page, log)) {
    await log("Blue Shield returned to bookmark page after login. Restarting from Provider login page.");
    await clickIfVisible(page, selectors.loginRegister, 5000);
  }

  const otpInput = await waitForVisible(page, selectors.otpInput, 12000);
  if (otpInput) {
    await waitForManualOtpCompletion(page, log);
    /*
    Auto-OTP flow is paused temporarily while OTP is entered manually.
    Uncomment this block when automatic shared-mailbox OTP should be re-enabled.

    await log("Blue Shield OTP page detected. Waiting for forwarded MFA email.");
    const otp = await waitForBlueShieldOtp({ group: credentials.group, mailbox: credentials.mailbox, log });
    await otpInput.fill(otp);
    await page.locator(selectors.otpSubmit).first().click();
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await assertNoSecurityBlock(page);
    await log("Blue Shield OTP verification submitted.");
    */
    await clickIfVisible(page, selectors.otpContinue, 5000);
    if (await handleOptionalBookmarkPage(page, log)) {
      await log("Blue Shield returned to bookmark page after OTP. Restarting from Provider login page.");
      await clickIfVisible(page, selectors.loginRegister, 5000);
    }
  } else {
    await log("Blue Shield OTP page was not shown. Continuing with existing trusted session.");
  }

  await log("Blue Shield login completed.");
}
