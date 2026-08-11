import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { readUhcEligibilityCredentials } from "../credentials";

async function credentialFile(rows: string[][]): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Login");
  sheet.addRow(["Project", "Portal", "Link", "Username", "Password", "Secret Key"]);
  rows.forEach((row) => sheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "credentials.xlsx");
}

test("selects only the TPM UHC credential row and its respective secret key", async () => {
  const credentials = await readUhcEligibilityCredentials(await credentialFile([
    ["TPM", "Availity", "availity.example", "availity-user", "availity-pass", "availity-secret"],
    ["Other", "UHC", "wrong-project.example", "wrong-user", "wrong-pass", "wrong-secret"],
    ["TPM", "UHC", "uhc.example", "uhc-user", "uhc-pass", "uhc-secret"],
  ]));

  assert.deepEqual(credentials, {
    loginUrl: "https://uhc.example",
    username: "uhc-user",
    password: "uhc-pass",
    totpSecret: "uhc-secret",
  });
});

test("does not fall back to credentials for another portal", async () => {
  await assert.rejects(
    readUhcEligibilityCredentials(await credentialFile([
      ["TPM", "Availity", "availity.example", "user", "pass", "secret"],
    ])),
    /Portal UHC/,
  );
});
