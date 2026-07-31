import assert from "node:assert/strict";
import test from "node:test";
import { generateAvailityEligibilityTotp } from "../totp";

function varint(value: number): Buffer {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value) byte |= 0x80;
    bytes.push(byte);
  } while (value);
  return Buffer.from(bytes);
}
function bytesField(field: number, value: Buffer): Buffer {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value]);
}
function numberField(field: number, value: number): Buffer {
  return Buffer.concat([varint(field << 3), varint(value)]);
}
function migrationDataValue(): string {
  const account = Buffer.concat([
    bytesField(1, Buffer.from("12345678901234567890")),
    bytesField(2, Buffer.from("Availity user")),
    bytesField(3, Buffer.from("Availity")),
    numberField(4, 1),
    numberField(5, 1),
    numberField(6, 2),
  ]);
  return encodeURIComponent(bytesField(1, account).toString("base64").replace(/=+$/, ""));
}

test("generates Availity OTP from raw Google Authenticator DATA_VALUE using Regal logic", () => {
  const originalNow = Date.now;
  Date.now = () => 59_000;
  try {
    assert.equal(generateAvailityEligibilityTotp(migrationDataValue()), "287082");
  } finally {
    Date.now = originalNow;
  }
});