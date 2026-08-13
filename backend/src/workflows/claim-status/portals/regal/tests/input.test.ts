import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { normalizeRegalGroup, normalizeRegalMemberName, readRegalClaimRowsFromBuffer, readRegalCredentialsFromBuffer } from "../input";
import { createRegalOutputWorkbookBuffer } from "../workbook";

test("normalizes Regal member name comma spacing and initial", () => {
  assert.equal(normalizeRegalMemberName("CAN,DIEGO A"), "CAN,DIEGO A");
  assert.equal(normalizeRegalMemberName("CAN, DIEGO A"), "CAN,DIEGO A");
  assert.equal(normalizeRegalMemberName("  CAN,   DIEGO   ALFONSO  "), "CAN,DIEGO A");
  assert.equal(normalizeRegalMemberName("CAN,DIEGO"), "CAN,DIEGO");
});

test("normalizes Regal group codes", () => {
  assert.equal(normalizeRegalGroup(" ippcs "), "IPPCS");
  assert.equal(normalizeRegalGroup("IP PS"), "IPPS");
});

test("reads Regal claim rows by Group, Member Name, and DOS headers", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Other", "DOS", "Group", "Member Name", "Account Number"],
      ["ignored", "6/16/26", "iphs", "CAN, DIEGO ALFONSO", "ACC-100"],
      ["ignored", "03/04/2026", "IPPCS", "SMITH, BRANDON", "ACC-200"],
    ]),
    "Input",
  );
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  const rows = readRegalClaimRowsFromBuffer(arrayBuffer);

  assert.deepEqual(rows, [
    { rowNumber: 2, accountNumber: "ACC-100", group: "IPHS", memberName: "CAN,DIEGO A", dos: "06/16/2026" },
    { rowNumber: 3, accountNumber: "ACC-200", group: "IPPCS", memberName: "SMITH,BRANDON", dos: "03/04/2026" },
  ]);
});

test("writes Regal Account Number as the first output column", () => {
  const buffer = createRegalOutputWorkbookBuffer([
    {
      "Account Number": "ACC-100",
      input_row_number: 2,
      input_group: "IPHS",
    },
  ]);
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheet = workbook.Sheets.Output;
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

  assert.equal(matrix[0]?.[0], "Account Number");
  assert.equal(matrix[1]?.[0], "ACC-100");
});

test("reads Regal login credentials from workbook", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        Link: "regalmed.okta.com/login",
        Username: "excel-user@example.com",
        Password: "excel-password",
      },
    ]),
    "Login",
  );
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  assert.deepEqual(readRegalCredentialsFromBuffer(arrayBuffer), {
    loginUrl: "https://regalmed.okta.com/login",
    username: "excel-user@example.com",
    password: "excel-password",
  });
});
