import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { normalizeRegalGroup, normalizeRegalMemberName, readRegalClaimRowsFromBuffer, readRegalCredentialsFromBuffer } from "../input";

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
      ["Other", "DOS", "Group", "Member Name"],
      ["ignored", "6/16/26", "iphs", "CAN, DIEGO ALFONSO"],
      ["ignored", "03/04/2026", "IPPCS", "SMITH, BRANDON"],
    ]),
    "Input",
  );
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;

  const rows = readRegalClaimRowsFromBuffer(arrayBuffer);

  assert.deepEqual(rows, [
    { rowNumber: 2, group: "IPHS", memberName: "CAN,DIEGO A", dos: "06/16/2026" },
    { rowNumber: 3, group: "IPPCS", memberName: "SMITH,BRANDON", dos: "03/04/2026" },
  ]);
});

test("reads Regal login credentials from workbook", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        "Login URL": "regalmed.okta.com/login",
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
