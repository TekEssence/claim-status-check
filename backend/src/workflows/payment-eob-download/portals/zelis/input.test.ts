import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { readZelisCredentials } from "./input";

async function workbookFile(headers: string[], values: string[]): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Credentials");
  sheet.addRow(headers);
  sheet.addRow(values);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  return new File([new Uint8Array(buffer)], "credentials.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

test("Zelis credentials resolve MedRevenue from the Project column without requiring Client Name", async () => {
  const file = await workbookFile(
    ["Project", "User Name", "Password", "Secret Key"],
    ["Med Revenue", "user", "password", "JBSWY3DPEHPK3PXP"],
  );

  const credentials = await readZelisCredentials(file);
  assert.equal(credentials.project, "medrevenue");
  assert.equal(credentials.clientName, "");
});

test("Zelis credentials default a missing Project column to Charm", async () => {
  const file = await workbookFile(
    ["User Name", "Password", "Secret Key"],
    ["user", "password", "JBSWY3DPEHPK3PXP"],
  );

  const credentials = await readZelisCredentials(file);
  assert.equal(credentials.project, "charm");
});
