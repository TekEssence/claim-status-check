import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import {
  findAvailityEligibilityCredentialsForPayer,
  readAvailityEligibilityCredentialProfiles,
  readAvailityEligibilityCredentials,
} from "../credentials";

async function credentialFile(rows: string[][], headers = ["Project", "Portal", "Payer", "Link", "Username", "Password", "Secret Key"]): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Login");
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "credentials.xlsx");
}

test("reads shared Availity credentials without requiring a payer column", async () => {
  const file = await credentialFile(
    [["TPM", "Availity", "availity.com", "user", "password", "secret"]],
    ["Project", "Portal", "Link", "Username", "Password", "Secret Key"],
  );
  const credentials = await readAvailityEligibilityCredentials(file);
  assert.equal(credentials.loginUrl, "https://availity.com");
  assert.equal(credentials.username, "user");
  assert.equal(credentials.password, "password");
  assert.equal(credentials.totpSecret, "secret");
});

test("matches payer-specific Availity credentials and permits a shared fallback", async () => {
  const profiles = await readAvailityEligibilityCredentialProfiles(await credentialFile([
    ["TPM", "Availity", "BCBS", "bcbs.example", "bcbs-user", "password", "secret-a"],
    ["TPM", "Availity", "Wellpoint", "wellpoint.example", "wellpoint-user", "password", "secret-b"],
  ]));

  assert.equal(
    findAvailityEligibilityCredentialsForPayer(profiles, "bcbs", "Blue Cross Blue Shield")?.username,
    "bcbs-user",
  );
  assert.equal(
    findAvailityEligibilityCredentialsForPayer(profiles, "wellpoint", "Van Lang IPA")?.username,
    "wellpoint-user",
  );
  assert.equal(
    findAvailityEligibilityCredentialsForPayer(profiles, "amerigroup", "Van Lang IPA"),
    null,
  );
});