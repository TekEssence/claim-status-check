"use strict";

const crypto = require("node:crypto");

function normalizeSecret(secret) {
  // Remove spaces/newlines that are commonly copied along with base32 secrets.
  return String(secret || "").replace(/\s+/g, "").trim();
}

function base32Decode(secret) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = normalizeSecret(secret).toUpperCase().replace(/=+$/g, "");
  let bits = "";

  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value === -1) {
      throw new Error("Invalid Availity TOTP secret: expected base32 characters.");
    }
    bits += value.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret, timeOffsetSeconds = 0) {
  // Create a time-based OTP dynamically at runtime from the shared secret.
  const normalizedSecret = normalizeSecret(secret);
  if (!normalizedSecret) {
    throw new Error("Availity TOTP secret is empty. Check the Secret Key column in the login Excel.");
  }

  const key = base32Decode(normalizedSecret);
  const counter = Math.floor((Date.now() + timeOffsetSeconds * 1000) / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % 1000000).padStart(6, "0");
}

module.exports = {
  generateTotp
};
