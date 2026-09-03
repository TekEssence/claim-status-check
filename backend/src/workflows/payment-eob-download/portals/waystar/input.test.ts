import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { isEligibleWaystarControlRow, isPendingStatus, isUsableCheckNumber, isWaystarSource, normalizeAmount, normalizePaymentNumber, readWaystarPaymentCredentials } from "./input";

async function workbookFile(mappingRows: string[][]): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const credentials = workbook.addWorksheet("Credentials");
  credentials.addRows([
    ["URL", "User Name", "Password", "Client Name"],
    ["https://login.zirmed.com/ui", "waystar-user", "secret", "TAJ"],
  ]);
  workbook.addWorksheet("Mapping").addRows(mappingRows);
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([buffer], "waystar.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

test("maps Waystar Client Name to its portal Account", async () => {
  const file = await workbookFile([["Client Name", "Account"], ["TAJ", "TAJ - Tariq Jamil, MD (247864)"]]);
  const credentials = await readWaystarPaymentCredentials(file);
  assert.equal(credentials.clientName, "TAJ");
  assert.equal(credentials.account, "TAJ - Tariq Jamil, MD (247864)");
});

test("matches Waystar Client Name mapping without case or punctuation sensitivity", async () => {
  const file = await workbookFile([["Client Name", "Account"], [" t-a_j ", "Tariq Jamil Portal Account"]]);
  const credentials = await readWaystarPaymentCredentials(file);
  assert.equal(credentials.account, "Tariq Jamil Portal Account");
});

test("rejects a Waystar client without an Account mapping", async () => {
  const file = await workbookFile([["Client Name", "Account"], ["BPH", "BPH Portal Account"]]);
  await assert.rejects(() => readWaystarPaymentCredentials(file), /does not contain an Account for Client Name "TAJ"/);
});

test("Waystar payment comparison normalizes check numbers and currency", () => {
  assert.equal(normalizePaymentNumber(" 001 23.0 "), "00123");
  assert.equal(normalizeAmount("$1,000.19"), 100019);
  assert.equal(normalizeAmount("1000.190"), 100019);
});

test("Waystar accepts only Pending entry status", () => {
  for (const value of ["Pending", "PENDING", " pending "]) assert.equal(isPendingStatus(value), true, value);
  for (const value of ["In Progress", "In-Process", "Completed"]) assert.equal(isPendingStatus(value), false, value);
});

test("Waystar processes a row only when Source and Entry Status both qualify", () => {
  for (const value of ["Waystar", "WAY STAR", "way-star", "Way_Star"]) {
    assert.equal(isWaystarSource(value), true, value);
  }
  assert.equal(isEligibleWaystarControlRow({ source: "Waystar", entryStatus: "Pending" }), true);
  assert.equal(isEligibleWaystarControlRow({ source: "Web", entryStatus: "Pending" }), false);
  assert.equal(isEligibleWaystarControlRow({ source: "Waystar", entryStatus: "Completed" }), false);
});

test("Waystar rejects placeholder check numbers", () => {
  for (const value of ["", "-", "N/A", "none", "null"]) assert.equal(isUsableCheckNumber(value), false, value);
  assert.equal(isUsableCheckNumber("R35060729007230"), true);
});
