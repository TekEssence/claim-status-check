import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { createUniqueMemberWorkItems, loadBlueShieldMailConfigurationFromWorkbook, loadCredentialsFromWorkbook, readBlueShieldInputWorkbook } from "../input";
import type { BlueShieldInputRow } from "../types";

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function row(inputRowId: number, memberId: string, dos: string): BlueShieldInputRow {
  return {
    inputRowId,
    memberId,
    dos,
    cptCode: "",
    validationStatus: "valid",
    validationMessage: "",
  };
}

test("groups Blue Shield input rows by member and keeps all requested DOS values", () => {
  const workItems = createUniqueMemberWorkItems([
    row(2, " ABC 123 ", "1/2/2026"),
    row(3, "ABC123", "01/02/2026"),
    row(4, "ABC123", "01/03/2026"),
  ]);

  assert.equal(workItems.length, 1);
  assert.deepEqual(workItems[0], {
    memberId: "ABC123",
    dosValues: ["1/2/2026", "01/03/2026"],
    rowIds: [2, 3, 4],
    duplicateRowIds: [],
  });
});

test("reads CPT code from Blue Shield input workbook", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([{ "Member ID": "ABC123", DOS: "04/18/2026", "CPT Code": " 99214 " }]),
    "Input",
  );

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const rows = readBlueShieldInputWorkbook(bufferToArrayBuffer(buffer));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].cptCode, "99214");
});

test("loads Blue Shield mail configuration from workbook Mail configurations sheet", () => {
  const keys = [
    "SHARED_MFA_MAILBOX",
    "PORTAL_BLUE_SHIELD_IUMG_MFA_OWNER_MAILBOXES",
    "PORTAL_BLUE_SHIELD_OTP_SENDER_DOMAINS",
    "PORTAL_BLUE_SHIELD_OTP_TIMEOUT_MS",
  ];
  const previousValues = new Map(keys.map((key) => [key, process.env[key]]));

  try {
    for (const key of keys) {
      delete process.env[key];
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([{ Group: "IUMG", URL: "example.com", "User Name": "user", Password: "pass" }]),
      "Credentials",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ["Key", "Value"],
        ["SHARED_MFA_MAILBOX", "shared@example.com"],
        ["PORTAL_BLUE_SHIELD_IUMG_MFA_OWNER_MAILBOXES=owner@example.com"],
        ["PORTAL_BLUE_SHIELD_OTP_SENDER_DOMAINS", "blueshieldca.com"],
        ["PORTAL_BLUE_SHIELD_OTP_TIMEOUT_MS", "1"],
      ]),
      "Mail configurations",
    );

    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    loadBlueShieldMailConfigurationFromWorkbook(bufferToArrayBuffer(buffer));

    assert.equal(process.env.SHARED_MFA_MAILBOX, "shared@example.com");
    assert.equal(process.env.PORTAL_BLUE_SHIELD_IUMG_MFA_OWNER_MAILBOXES, "owner@example.com");
    assert.equal(process.env.PORTAL_BLUE_SHIELD_OTP_SENDER_DOMAINS, "blueshieldca.com");
    assert.equal(process.env.PORTAL_BLUE_SHIELD_OTP_TIMEOUT_MS, undefined);
  } finally {
    for (const [key, value] of previousValues) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test("uses IUMG credentials for groups that share the Skevin login", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        Group: "IUMG",
        URL: "https://login.example.com",
        "User Name": "skevin",
        Password: "secret",
        "Claim Status URL": "https://claims.example.com",
      },
    ]),
    "Credentials",
  );

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const credentials = loadCredentialsFromWorkbook(bufferToArrayBuffer(buffer), "BPH");

  assert.equal(credentials?.group, "IUMG");
  assert.equal(credentials?.username, "skevin");
  assert.equal(credentials?.password, "secret");
});

test("uses selected group credentials before shared IUMG fallback when present", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        Group: "IUMG",
        URL: "https://iumg-login.example.com",
        "User Name": "skevin",
        Password: "iumg-secret",
      },
      {
        Group: "BPH",
        URL: "https://bph-login.example.com",
        "User Name": "bph-user",
        Password: "bph-secret",
      },
    ]),
    "Credentials",
  );

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const credentials = loadCredentialsFromWorkbook(bufferToArrayBuffer(buffer), "BPH");

  assert.equal(credentials?.group, "BPH");
  assert.equal(credentials?.loginUrl, "https://bph-login.example.com");
  assert.equal(credentials?.username, "bph-user");
  assert.equal(credentials?.password, "bph-secret");
});
