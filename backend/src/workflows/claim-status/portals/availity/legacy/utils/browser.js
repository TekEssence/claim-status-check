"use strict";
const logger = require("./logger");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function humanDelay(minMs = 500, maxMs = 1200) {
  const duration = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  await wait(duration);
}

async function withRetry(stepName, operation, options = {}) {
  const retries = options.retries ?? 2;
  const retryDelayMs = options.retryDelayMs ?? 1200;

  let lastError;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      logger.info(`${stepName} (attempt ${attempt}/${retries + 1})`);
      const result = await operation(attempt);
      logger.success(`${stepName} completed`);
      return result;
    } catch (error) {
      lastError = error;
      const message = error && error.message ? error.message : String(error);
      logger.warn(`${stepName} failed on attempt ${attempt}: ${message}`);

      if (attempt <= retries) {
        logger.info(`Retrying ${stepName} after ${retryDelayMs} ms`);
        await wait(retryDelayMs);
      }
    }
  }

  throw new Error(`${stepName} failed after ${retries + 1} attempts. Last error: ${lastError.message}`);
}

async function launchBrowser(timeouts) {
  throw new Error("Legacy launchBrowser is disabled in the integrated Availity portal. Use backend/src/workflows/claim-status/portals/availity/browser.ts.");
}

module.exports = {
  launchBrowser,
  withRetry,
  humanDelay,
  wait
};
