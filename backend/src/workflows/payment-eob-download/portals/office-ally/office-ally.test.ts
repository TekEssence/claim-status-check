import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { reportDates, readOfficeAllyCredentials } from "./input";
import { createOfficeAllyWorkbook, saveOriginalZip, validateOriginalFilename, type OfficeAllyReport } from "./output";
import { getPaymentEobRunner } from "../../registry";
import { getPaymentEobPortal } from "../../../../../../frontend/src/workflows/payment-eob-download/registry";
import { createStoredZipFromFolder } from "../availity-remittance/zip";

async function credentialFile(rows: unknown[][]): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Credentials").addRows([
    ["Login URL", "Username", "Password", "Start Date", "End Date"], ...rows,
  ]);
  return new File([new Uint8Array(await workbook.xlsx.writeBuffer())], "credentials.xlsx");
}

test("inclusive dates cross weekends, month/year boundaries, and leap days", () => {
  assert.deepEqual(reportDates("09/07/2026", "09/11/2026"), ["9/7/2026", "9/8/2026", "9/9/2026", "9/10/2026", "9/11/2026"]);
  assert.deepEqual(reportDates("12/31/2026", "01/02/2027"), ["12/31/2026", "1/1/2027", "1/2/2027"]);
  assert.deepEqual(reportDates("02/28/2024", "03/01/2024"), ["2/28/2024", "2/29/2024", "3/1/2024"]);
  assert.deepEqual(reportDates("09/12/2026", "09/13/2026"), ["9/12/2026", "9/13/2026"]);
  for (const [start, end] of [["", "09/11/2026"], ["02/29/2026", "03/01/2026"], ["09/11/2026", "09/07/2026"], ["9-7", "9-11"]]) {
    assert.throws(() => reportDates(start, end));
  }
});

test("reads the agreed workbook including Excel dates, preserves password, rejects ambiguous accounts", async () => {
  const row = ["https://www.officeally.com/sLogin.aspx", "test-user", " password ", new Date(Date.UTC(2026, 8, 7)), "09/11/2026"];
  const credentials = await readOfficeAllyCredentials(await credentialFile([row]));
  assert.equal(credentials.password, " password ");
  assert.equal(credentials.dates.length, 5);
  await assert.rejects(readOfficeAllyCredentials(await credentialFile([row, row])), /exactly one/);
  await assert.rejects(readOfficeAllyCredentials(await credentialFile([[...row.slice(0, 3), "", "09/11/2026"]])), /Start Date/);
});

test("portal accepts only a credential upload without project or control log", async () => {
  const runner = getPaymentEobRunner("office-ally");
  const form = new FormData();
  const file = await credentialFile([]);
  form.set("credentialExcel", file);
  assert.deepEqual(runner.validateInput(form), { credentialExcel: file });
  assert.equal(getPaymentEobPortal("office-ally")?.requiresReferenceExcel, false);
  assert.throws(() => runner.validateInput(new FormData()), /Credential Excel/);
});

test("workbook has exactly seven columns and keeps identifiers as text", async () => {
  const row: OfficeAllyReport = { date: "9/10/2026", reportType: "ERA 835", fileId: "001640601333", fileName: "original.zip", eobId: "0036E790D5", records: "1", status: "Failed" };
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(await createOfficeAllyWorkbook([row])).buffer);
  const sheet = workbook.worksheets[0];
  assert.deepEqual((sheet.getRow(1).values as unknown[]).slice(1), ["Date", "Report Type", "File ID", "File Name", "EOB ID", "# Records", "Office Ally Download Status"]);
  assert.equal(sheet.getCell("C2").value, row.fileId);
  assert.equal(sheet.getCell("E2").value, row.eobId);
  assert.equal(sheet.getCell("G2").value, "Failed");
});

test("ZIP bytes and names survive packaging; duplicates do not overwrite or rename", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "office-ally-test-"));
  try {
    const zip = Buffer.alloc(22); zip.writeUInt32LE(0x06054b50);
    const name = "1640601333_ERA_STATUS_5010_20260910.zip";
    assert.equal(await saveOriginalZip(folder, name, zip), "Downloaded");
    assert.equal(await saveOriginalZip(folder, name, zip), "Already saved");
    const different = Buffer.from(zip); different[20] = 1;
    await assert.rejects(saveOriginalZip(folder, name, different), /different ZIP/);
    await assert.rejects(saveOriginalZip(folder, "error.zip", Buffer.from("<html>Login</html>")), /non-ZIP/);
    for (const invalid of ["../file.zip", "folder\\file.zip", "file.zip ", "CON.zip", "file.pdf"]) assert.throws(() => validateOriginalFilename(invalid));
    await fs.writeFile(path.join(folder, "office_ally_download_status.xlsx"), await createOfficeAllyWorkbook([]));
    const bundle = await createStoredZipFromFolder(folder, "OfficeAllyPaymentEobDownloads");
    assert.ok(bundle.includes(Buffer.from(`OfficeAllyPaymentEobDownloads/${name}`)));
    assert.ok(bundle.includes(Buffer.from("OfficeAllyPaymentEobDownloads/office_ally_download_status.xlsx")));
    assert.deepEqual(await fs.readFile(path.join(folder, name)), zip);
    assert.equal((await fs.readdir(folder)).length, 2);
  } finally {
    // mkdtemp creates this exact test-owned folder under the system temp directory.
    await fs.rm(folder, { recursive: true, force: true });
  }
});
