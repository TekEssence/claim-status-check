"use strict";

const logger = require("../utils/logger");
const { humanDelay, withRetry } = require("../utils/browser");

const SELECTORS = {
  claimStatusIframe: "iframe#newBodyFrame",
  acceptCookiesButton: "button#onetrust-accept-btn-handler",
  acceptCookiesButtonByText: "button:has-text('Accept All Cookies')",
  claimsPaymentsMenu: "button.NavDropdown__trigger[aria-label='Claims & Payments']",
  claimStatusLink: "div.NavLinkItem__link--content[title='Claim Status']",
  claimStatusText: "text=Claim Status",
  claimStatusHeading: "h1:has-text('Claim Status')",
  claimStatusAppIcon: "span[data-testid='page-header-app-icon'][title='Claim Status']",
  organizationLabel: "label#organization-label",
  organizationInput: "input#organization[role='combobox']",
  payerLabel: "label#payer-label",
  payerInput: "input#payer[role='combobox']",
  logoutButton: "button#logout-link, button:has-text('Logout')"
};

async function getClaimStatusFrame(page, timeoutMs = 30000) {
  await page.locator(SELECTORS.claimStatusIframe).waitFor({ state: "attached", timeout: timeoutMs });
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame = page.frame({ name: "newBody" }) || page.frame({ url: /enhanced-claim-status-ui/ });
    if (frame && !frame.isDetached()) {
      return frame;
    }

    await humanDelay(200, 400);
  }

  throw new Error("Claim Status iframe newBody was attached, but its frame context was not available.");
}

async function waitForUrlChangeOrClaimStatus(page, previousUrl) {
  await Promise.race([
    page.waitForFunction((url) => window.location.href !== url, previousUrl, { timeout: 30000 }),
    waitForClaimStatusPage(page)
  ]);
}

async function isClaimStatusPageOpen(page, timeoutMs = 3000) {
  const frame = await getClaimStatusFrame(page, timeoutMs).catch(() => null);
  if (!frame) {
    return false;
  }

  const headingVisible = await frame.locator(SELECTORS.claimStatusHeading).first().isVisible({ timeout: timeoutMs }).catch(() => false);
  const organizationLabelVisible = await frame.locator(SELECTORS.organizationLabel).first().isVisible({ timeout: timeoutMs }).catch(() => false);
  const payerLabelVisible = await frame.locator(SELECTORS.payerLabel).first().isVisible({ timeout: timeoutMs }).catch(() => false);

  return headingVisible && organizationLabelVisible && payerLabelVisible;
}

async function waitForClaimStatusPage(page) {
  const deadline = Date.now() + 30000;

  while (Date.now() < deadline) {
    if (await isClaimStatusPageOpen(page, 1000)) {
      return;
    }

    await humanDelay(300, 600);
  }

  throw new Error("Claim Status page indicators were not detected in the main page or frames.");
}

async function areClaimStatusControlsReady(page) {
  const frame = await getClaimStatusFrame(page, 5000).catch(() => null);
  if (!frame) {
    return false;
  }

  return Boolean(await frame.evaluate(() => {
    const isVisible = (selector) => {
      return Array.from(document.querySelectorAll(selector)).some((element) => {
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      });
    };

    const organizationReady = isVisible("#orgSelect")
      || isVisible(".organization-select__control")
      || isVisible("input#organization[role='combobox']");
    const payerReady = isVisible("input#payer[role='combobox']")
      || isVisible("input#payerSelect[role='combobox']")
      || isVisible(".payer-select__control");

    return organizationReady && payerReady;
  }).catch(() => false));
}

async function waitForClaimStatusControlsReady(page, totalTimeoutMs = 30000, chunkMs = 3000) {
  const attempts = Math.max(1, Math.ceil(totalTimeoutMs / chunkMs));

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (await areClaimStatusControlsReady(page)) {
      logger.info("Availity Claim Status controls are ready.");
      return;
    }

    if (attempt < attempts) {
      logger.info(`Availity Claim Status controls not ready after ${(attempt - 1) * chunkMs} ms. Waiting another ${chunkMs / 1000} seconds.`);
      await humanDelay(chunkMs, chunkMs + 200);
    }
  }

  if (await areClaimStatusControlsReady(page)) {
    logger.info("Availity Claim Status controls are ready.");
    return;
  }

  throw new Error(`Availity Claim Status controls were not ready after ${totalTimeoutMs / 1000} seconds.`);
}

async function waitForHomeNavigation(page) {
  await page.waitForSelector(SELECTORS.claimsPaymentsMenu, { state: "visible", timeout: 45000 });
}

async function findVisibleCookieButton(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const byId = frame.locator(SELECTORS.acceptCookiesButton).first();
      if (await byId.isVisible({ timeout: 500 }).catch(() => false)) {
        return byId;
      }

      const byText = frame.locator(SELECTORS.acceptCookiesButtonByText).first();
      if (await byText.isVisible({ timeout: 500 }).catch(() => false)) {
        return byText;
      }
    }

    await humanDelay(300, 600);
  }

  return null;
}

async function acceptCookiesIfPresent(page, timeoutMs = 30000) {
  const acceptButton = await findVisibleCookieButton(page, timeoutMs);

  if (!acceptButton) {
    logger.info("Cookie banner not visible; continuing");
    return;
  }

  await withRetry(
    "Accepting cookies",
    async () => {
      await acceptButton.click({ force: true });
    },
    { retries: 1, retryDelayMs: 800 }
  );

  await page.locator(SELECTORS.acceptCookiesButton).waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  await humanDelay(700, 1200);
}

async function openClaimStatus(page, options = {}) {
  const forceOpen = options.forceOpen === true;

  await waitForHomeNavigation(page);
  await acceptCookiesIfPresent(page, 5000);

  if (!forceOpen && await isClaimStatusPageOpen(page, 3000)) {
    await waitForClaimStatusControlsReady(page);
    return;
  }

  await withRetry(
    "Opening Claims & Payments menu",
    async () => {
      const menuButton = page.locator(SELECTORS.claimsPaymentsMenu).first();
      await menuButton.click();
      await page.locator(SELECTORS.claimStatusLink).first().waitFor({ state: "visible", timeout: 10000 });
    },
    { retries: 2, retryDelayMs: 1000 }
  );

  await humanDelay(400, 900);

  await withRetry(
    "Opening Claim Status page",
    async () => {
      if (!forceOpen && await isClaimStatusPageOpen(page, 1000)) {
        return;
      }

      const previousUrl = page.url();
      const claimStatusLink = page.locator(SELECTORS.claimStatusLink).first();
      if (await claimStatusLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        await claimStatusLink.click();
      } else {
        if (!forceOpen && await isClaimStatusPageOpen(page, 1000)) {
          return;
        }
        await page.locator(SELECTORS.claimStatusText).first().click();
      }

      await waitForUrlChangeOrClaimStatus(page, previousUrl);
      if (await isClaimStatusPageOpen(page, 5000)) {
        return;
      }

      logger.info("Claim Status URL changed after click; continuing despite selector detection fallback.");
    },
    { retries: 2, retryDelayMs: 1500 }
  );

  await waitForClaimStatusControlsReady(page);
}

async function logoutIfPresent(page, timeoutMs = 5000) {
  if (!page || page.isClosed()) {
    return false;
  }

  const logoutButton = page.locator(SELECTORS.logoutButton).first();
  if (!await logoutButton.isVisible({ timeout: timeoutMs }).catch(() => false)) {
    logger.warn("Logout button was not visible before browser restart; closing browser directly.");
    return false;
  }

  await logoutButton.click({ force: true });
  logger.info("Logout clicked before browser restart.");
  await humanDelay(1000, 2000);
  return true;
}

module.exports = {
  acceptCookiesIfPresent,
  getClaimStatusFrame,
  isClaimStatusPageOpen,
  logoutIfPresent,
  openClaimStatus,
  SELECTORS
};
