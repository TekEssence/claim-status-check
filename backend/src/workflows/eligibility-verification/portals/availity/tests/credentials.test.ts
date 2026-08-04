import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { readAvailityEligibilityCredentials } from "../credentials";

async function sharedCredentialFile(): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Login");
  sheet.addRow(["Project", "Portal", "Link", "Username", "Password", "Secret Key"]);
  sheet.addRow(["TPM", "Availity", "availity.com", "user", "password", "secret"]);
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "credentials.xlsx");
}

test("reads shared Availity credentials without requiring a payer column", async () => {
  const credentials = await readAvailityEligibilityCredentials(await sharedCredentialFile());
  assert.equal(credentials.loginUrl, "https://availity.com");
  assert.equal(credentials.username, "user");
  assert.equal(credentials.password, "password");
  assert.equal(credentials.totpSecret, "secret");
});