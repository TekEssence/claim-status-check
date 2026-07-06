"use strict";

const { humanDelay, withRetry } = require("../utils/browser");

const SELECTORS = {
  usernameInput: "input#userId[name='userId']",
  passwordInput: "input#password[name='password']",
  loginButton: "button:has-text('Sign In')"
};

async function verifyLoginPage(page) {
  await page.waitForSelector(SELECTORS.usernameInput, { state: "visible" });
  await page.waitForSelector(SELECTORS.passwordInput, { state: "visible" });
}

async function submitLogin(page, username, password) {
  await verifyLoginPage(page);
  await humanDelay();
  await page.fill(SELECTORS.usernameInput, username);
  await humanDelay();
  await page.fill(SELECTORS.passwordInput, password);
  await humanDelay(600, 1300);

  await withRetry(
    "Submitting login form",
    async () => {
      await page.click(SELECTORS.loginButton);
    },
    { retries: 2, retryDelayMs: 1200 }
  );
}

module.exports = {
  submitLogin,
  verifyLoginPage,
  SELECTORS
};
