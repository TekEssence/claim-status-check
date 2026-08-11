import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { readAdvancedMdCredentials } from "../credentials";

test("reads AdvancedMD office key credential alias", async () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Credentials");
  worksheet.addRow(["Login URL", "Login name", "Password", "Office key"]);
  worksheet.addRow(["login.advancedmd.com", "demo-user", "secret", "SANTO"]);
  const buffer = await workbook.xlsx.writeBuffer();

  const credentials = await readAdvancedMdCredentials(new File([Buffer.from(buffer)], "credentials.xlsx"));

  assert.equal(credentials.loginUrl, "https://login.advancedmd.com");
  assert.equal(credentials.username, "demo-user");
  assert.equal(credentials.officeKey, "SANTO");
});
