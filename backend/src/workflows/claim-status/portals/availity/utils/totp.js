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

function readVarint(buffer, offset) {
  let value = 0;
  let shift = 0;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index];
    value |= (byte & 0x7f) << shift;
    index += 1;
    if ((byte & 0x80) === 0) return { value, offset: index };
    shift += 7;
  }
  throw new Error("Invalid Google Authenticator migration payload: truncated varint.");
}

function parseOtpParameters(buffer) {
  const account = {
    secret: null,
    algorithm: 1,
    digits: 1,
    type: 2
  };
  let offset = 0;

  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 7;

    if (wireType === 0) {
      const parsed = readVarint(buffer, offset);
      offset = parsed.offset;
      if (fieldNumber === 4) account.algorithm = parsed.value;
      if (fieldNumber === 5) account.digits = parsed.value;
      if (fieldNumber === 6) account.type = parsed.value;
      continue;
    }

    if (wireType === 2) {
      const length = readVarint(buffer, offset);
      offset = length.offset;
      const end = offset + length.value;
      if (end > buffer.length) {
        throw new Error("Invalid Google Authenticator migration payload: field length exceeds payload.");
      }
      if (fieldNumber === 1) account.secret = buffer.subarray(offset, end);
      offset = end;
      continue;
    }

    throw new Error(`Unsupported Google Authenticator migration field wire type: ${wireType}.`);
  }

  return account;
}

function decodeGoogleAuthenticatorMigration(secret) {
  const rawSecret = String(secret || "").trim();
  const dataMatch = rawSecret.match(/[?&]data=([^&]+)/i);
  const dataValue = dataMatch ? dataMatch[1] : rawSecret;
  const decoded = decodeURIComponent(dataValue).replace(/\s+/g, "");
  const padded = decoded + "=".repeat((4 - (decoded.length % 4)) % 4);
  const payload = Buffer.from(padded, "base64");
  let offset = 0;

  while (offset < payload.length) {
    const tag = readVarint(payload, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 7;

    if (wireType === 0) {
      const parsed = readVarint(payload, offset);
      offset = parsed.offset;
      continue;
    }

    if (wireType !== 2) {
      throw new Error(`Unsupported Google Authenticator migration payload wire type: ${wireType}.`);
    }

    const length = readVarint(payload, offset);
    offset = length.offset;
    const end = offset + length.value;
    if (end > payload.length) {
      throw new Error("Invalid Google Authenticator migration payload: account length exceeds payload.");
    }

    if (fieldNumber === 1) {
      const account = parseOtpParameters(payload.subarray(offset, end));
      if (account.type !== 2) {
        throw new Error("Google Authenticator migration payload account is HOTP, not TOTP.");
      }
      if (!account.secret || account.secret.length === 0) {
        throw new Error("Google Authenticator migration payload does not contain a TOTP secret.");
      }
      return {
        key: account.secret,
        algorithm: account.algorithm,
        digits: account.digits === 2 ? 8 : 6
      };
    }

    offset = end;
  }

  throw new Error("Google Authenticator migration payload does not contain any TOTP accounts.");
}

function digestForAlgorithm(algorithm) {
  if (algorithm === 2) return "sha256";
  if (algorithm === 3) return "sha512";
  if (algorithm === 4) return "md5";
  return "sha1";
}

function resolveTotpConfig(secret, options = {}) {
  if (options.totpSecretFormat === "google-authenticator-migration") {
    const rawSecret = String(secret || "").trim();
    const compactSecret = normalizeSecret(rawSecret);
    const isMigrationValue =
      /^otpauth-migration:\/\//i.test(rawSecret) ||
      /[?&]data=/i.test(rawSecret);
    const isBase32Secret = /^[A-Z2-7]+=*$/i.test(compactSecret);

    // Charm workbooks may contain either the raw Base32 key or the exported
    // Google Authenticator migration value. Do not parse Base32 as protobuf.
    if (!isMigrationValue && isBase32Secret) {
      return {
        key: base32Decode(compactSecret),
        digest: "sha1",
        digits: 6
      };
    }

    const migration = decodeGoogleAuthenticatorMigration(secret);
    return {
      key: migration.key,
      digest: digestForAlgorithm(migration.algorithm),
      digits: migration.digits
    };
  }

  return {
    key: base32Decode(normalizeSecret(secret)),
    digest: "sha1",
    digits: 6
  };
}

function generateTotp(secret, timeOffsetSeconds = 0, options = {}) {
  // Create a time-based OTP dynamically at runtime from the shared secret.
  const normalizedSecret = normalizeSecret(secret);
  if (!normalizedSecret) {
    throw new Error("Availity TOTP secret is empty. Check the Secret Key column in the login Excel.");
  }

  const { key, digest, digits } = resolveTotpConfig(secret, options);
  const counter = Math.floor((Date.now() + timeOffsetSeconds * 1000) / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac(digest, key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(code % (10 ** digits)).padStart(digits, "0");
}

module.exports = {
  generateTotp,
  decodeGoogleAuthenticatorMigration
};
