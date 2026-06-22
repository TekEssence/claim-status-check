import assert from "node:assert/strict";
import test from "node:test";
import { generateRegalTotpCode } from "../totp";

test("generates standard 6-digit TOTP from a base32 secret", () => {
  const previousSecret = process.env.REGAL_TOTP_SECRET;
  const previousDataValue = process.env.REGAL_TOTP_DATA_VALUE;
  const previousData = process.env.DATA_VALUE;

  try {
    process.env.REGAL_TOTP_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    delete process.env.REGAL_TOTP_DATA_VALUE;
    delete process.env.DATA_VALUE;

    assert.equal(generateRegalTotpCode(59_000), "287082");
  } finally {
    if (previousSecret == null) delete process.env.REGAL_TOTP_SECRET;
    else process.env.REGAL_TOTP_SECRET = previousSecret;

    if (previousDataValue == null) delete process.env.REGAL_TOTP_DATA_VALUE;
    else process.env.REGAL_TOTP_DATA_VALUE = previousDataValue;

    if (previousData == null) delete process.env.DATA_VALUE;
    else process.env.DATA_VALUE = previousData;
  }
});
