"use strict";

const path = require("path");
const dotenv = require("dotenv");

function parsePositiveInt(value, fallbackValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackValue;
}

function parseInteger(value, fallbackValue) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
}

function parseBoolean(value, fallbackValue) {
  if (typeof value !== "string") {
    return fallbackValue;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n"].includes(normalized)) {
    return false;
  }

  return fallbackValue;
}

function loadEnv() {
  // Step 1: Load local configuration from .env.local at the project root.
  // This file can optionally point to a second env file in a different folder.
  const localEnvPath = path.resolve(__dirname, "..", ".env.local");
  dotenv.config({ path: localEnvPath });

  // Step 2: If EXTERNAL_ENV_FILE is provided, load it and override local keys.
  // This allows secure credentials to be stored outside the project directory.
  const externalEnvFile = process.env.EXTERNAL_ENV_FILE;
  if (externalEnvFile && externalEnvFile.trim()) {
    dotenv.config({ path: externalEnvFile.trim(), override: true });
  }

  // Validate mandatory secrets and credentials for secure runtime usage.
  // Variable names follow the user's current env naming standard.
  const requiredKeys = ["USERNAME_AVA1", "PASSWORD_AVA1", "TOTP_SECRET", "LOGIN_URL_AVA"];
  const missing = requiredKeys.filter((key) => !process.env[key] || !process.env[key].trim());

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return {
    username: process.env.USERNAME_AVA1,
    password: process.env.PASSWORD_AVA1,
    totpSecret: process.env.TOTP_SECRET,
    loginUrl: process.env.LOGIN_URL_AVA,
    successUrlFragment: process.env.SUCCESS_URL_FRAGMENT || "",
    claimStatusUrlFragment: process.env.SUCCESS_URL_CLAIM_STATUS_PAGE || "",
    keepBrowserOpen: parseBoolean(process.env.KEEP_BROWSER_OPEN, true),
    mfaMaxAttempts: parsePositiveInt(process.env.MFA_MAX_ATTEMPTS, 1),
    totpTimeOffsetSeconds: parseInteger(process.env.TOTP_TIME_OFFSET_SECONDS, 0),
    totpMinValidSeconds: parsePositiveInt(process.env.TOTP_MIN_VALID_SECONDS, 20),
    timeouts: {
      default: parsePositiveInt(process.env.DEFAULT_TIMEOUT_MS, 30000),
      navigation: parsePositiveInt(process.env.NAVIGATION_TIMEOUT_MS, 45000)
    }
  };
}

module.exports = {
  loadEnv
};
