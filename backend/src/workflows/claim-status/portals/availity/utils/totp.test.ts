import assert from "node:assert/strict";
import test from "node:test";

const { decodeGoogleAuthenticatorMigration, generateTotp } = require("./totp");

const MIGRATION_DATA =
  "CnMKQMpxyRlBK7V3XEtbtGw2wbIXxBK%2Frq3qOdpQgOvynXsG1Xy4Y44HCE2TGNy2p8CMbe%2BCgnTvLKkADXvmTS3AetoSCnJjbWJyYW5kb24aCEF2YWlsaXR5IAEoATACQhNiYmM3NTQxNzgwMzIyNDkwMTI2EAIYASAA";

test("Charm accepts a raw Base32 secret with migration format configured", () => {
  const code = generateTotp("JBSWY3DPEHPK3PXP", 0, {
    totpSecretFormat: "google-authenticator-migration",
  });
  assert.match(code, /^\d{6}$/);
});

test("Charm still accepts Google Authenticator migration data", () => {
  const account = decodeGoogleAuthenticatorMigration(
    `otpauth-migration://offline?data=${MIGRATION_DATA}`,
  );
  assert.ok(account.key.length > 0);
  assert.equal(account.digits, 6);
});
