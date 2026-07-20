"use strict";

const logger = require("../utils/logger");
const { generateTotp } = require("../utils/totp");
const { humanDelay, wait, withRetry } = require("../utils/browser");

const SELECTORS = {
  methodOption: "input[name='choice'][value='Authenticate me using my Authenticator app']",
  methodContinueButton: "button:has-text('Continue')",
  codeInput: "input#code[name='code']",
  submitButton: "button:has-text('Continue')",
  invalidMessage: "text=/invalid|not valid|incorrect|expired|try again/i"
};

async function isVisibleQuick(page, selector, timeoutMs = 3000) {
  try {
    await page.waitForSelector(selector, { state: "visible", timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function verifyCodePage(page) {
  await page.waitForSelector(SELECTORS.codeInput, { state: "visible" });
}

async function waitForMfaSubmitOutcome(page, previousUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const urlChanged = page.url() !== previousUrl;
    if (urlChanged) {
      return "success";
    }

    const invalidVisible = await isVisibleQuick(page, SELECTORS.invalidMessage, 500);
    if (invalidVisible) {
      return "rejected";
    }

    await wait(700);
  }

  return "timeout";
}

async function handleMfa(page, totpSecret, maxAttempts, totpTimeOffsetSeconds = 0, totpMinValidSeconds = 20, mfaConfig = {}) {
  const directCodePage = await isVisibleQuick(page, SELECTORS.codeInput, 4000);

  if (!directCodePage) {
    const methodPage = await isVisibleQuick(page, SELECTORS.methodOption, 4000);
    if (!methodPage) {
      throw new Error("MFA screen not found. Expected authenticator method or code page.");
    }

    logger.info("MFA method selection page detected");
    await page.click(SELECTORS.methodOption);
    logger.success("Selected authenticator app MFA option");

    await humanDelay(500, 1200);
    await withRetry(
      "Submitting MFA method selection",
      async () => {
        await page.click(SELECTORS.methodContinueButton);
      },
      { retries: 2, retryDelayMs: 1200 }
    );

    await verifyCodePage(page);
  }

  let previousOtp = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await humanDelay(700, 1500);

    let nowSec = Math.floor((Date.now() + totpTimeOffsetSeconds * 1000) / 1000);
    let secondsRemaining = 30 - (nowSec % 30);
    if (secondsRemaining < totpMinValidSeconds) {
      const nextWindowSettleSeconds = 3;
      const waitSeconds = secondsRemaining + nextWindowSettleSeconds;
      logger.info(`Waiting ${waitSeconds}s for next OTP window; current code has less than ${totpMinValidSeconds}s remaining`);
      await wait(waitSeconds * 1000);
      nowSec = Math.floor((Date.now() + totpTimeOffsetSeconds * 1000) / 1000);
      secondsRemaining = 30 - (nowSec % 30);
    }

    let otpCode = generateTotp(totpSecret, totpTimeOffsetSeconds, mfaConfig);
    if (previousOtp && otpCode === previousOtp) {
      await wait(12000);
      otpCode = generateTotp(totpSecret, totpTimeOffsetSeconds, mfaConfig);
    }
    previousOtp = otpCode;

    logger.success(`MFA code generated (attempt ${attempt}/${maxAttempts}, offset=${totpTimeOffsetSeconds}s, valid_for_about=${secondsRemaining}s)`);
    await page.fill(SELECTORS.codeInput, otpCode);
    await humanDelay(500, 1200);

    const previousUrl = page.url();
    await withRetry(
      "Submitting MFA form",
      async () => {
        await page.click(SELECTORS.submitButton);
      },
      { retries: 2, retryDelayMs: 1200 }
    );

    const outcome = await waitForMfaSubmitOutcome(page, previousUrl, 20000);
    if (outcome === "success") {
      logger.success("MFA submitted successfully");
      return;
    }

    logger.warn(outcome === "rejected" ? `MFA code rejected on attempt ${attempt}` : `MFA page still visible after attempt ${attempt}`);
  }

  throw new Error("MFA failed after configured OTP attempts.");
}

async function openMfaCodePage(page) {
  const directCodePage = await isVisibleQuick(page, SELECTORS.codeInput, 4000);

  if (directCodePage) {
    return;
  }

  const methodPage = await isVisibleQuick(page, SELECTORS.methodOption, 4000);
  if (!methodPage) {
    throw new Error("MFA screen not found. Expected authenticator method or code page.");
  }

  logger.info("MFA method selection page detected");
  await page.click(SELECTORS.methodOption);
  logger.success("Selected authenticator app MFA option");

  await humanDelay(500, 1200);
  await withRetry(
    "Submitting MFA method selection",
    async () => {
      await page.click(SELECTORS.methodContinueButton);
    },
    { retries: 2, retryDelayMs: 1200 }
  );

  await verifyCodePage(page);
}

async function handleManualMfa(page, requestOtp, maxAttempts = 2) {
  await openMfaCodePage(page);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const otpCode = await requestOtp(attempt, maxAttempts);
    await page.fill(SELECTORS.codeInput, String(otpCode || "").trim());
    await humanDelay(500, 1200);

    const previousUrl = page.url();
    await withRetry(
      "Submitting manual MFA form",
      async () => {
        await page.click(SELECTORS.submitButton);
      },
      { retries: 2, retryDelayMs: 1200 }
    );

    const outcome = await waitForMfaSubmitOutcome(page, previousUrl, 20000);
    if (outcome === "success") {
      logger.success("Manual MFA submitted successfully");
      return;
    }

    logger.warn(outcome === "rejected" ? `Manual MFA code rejected on attempt ${attempt}` : `Manual MFA page still visible after attempt ${attempt}`);
  }

  throw new Error("Manual MFA failed after configured OTP attempts.");
}

module.exports = {
  handleMfa,
  handleManualMfa,
  SELECTORS
};
