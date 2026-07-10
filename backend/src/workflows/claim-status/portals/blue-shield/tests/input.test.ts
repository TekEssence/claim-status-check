import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import {
  createUniqueMemberWorkItems,
  loadBlueShieldMailConfigurationFromWorkbook,
  loadCredentialsFromWorkbook,
  readBlueShieldInputWorkbook,
  routeBlueShieldRowsByCredentials,
} from "../input";
import type { BlueShieldInputRow } from "../types";
import { createBlueShieldErrorReportBuffer } from "../output-writer";

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function row(inputRowId: number, memberId: string, dos: string): BlueShieldInputRow {
  return {
    inputRowId,
    group: "IUMG",
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
    XLSX.utils.json_to_sheet([{ Group: "IUMG", "Member ID": "ABC123", DOS: "04/18/2026", "CPT Code": " 99214 " }]),
    "Input",
  );

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const rows = readBlueShieldInputWorkbook(bufferToArrayBuffer(buffer));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].cptCode, "99214");
  assert.equal(rows[0].group, "IUMG");
});

test("groups claim rows by unique credentials while preserving first group order", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        Group: "IUMG",
        URL: "https://shared.example.com",
        "User Name": "shared-user",
        Password: "shared-pass",
      },
      {
        Group: "Posada",
        URL: "https://posada.example.com",
        "User Name": "posada-user",
        Password: "posada-pass",
      },
    ]),
    "Credentials",
  );
  const credentialBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const rows = [
    { ...row(2, "M1", "01/01/2026"), group: "IUMG" },
    { ...row(3, "M2", "01/02/2026"), group: "BPH" },
    { ...row(4, "M3", "01/03/2026"), group: "Posada" },
  ];

  const routing = routeBlueShieldRowsByCredentials(
    rows,
    bufferToArrayBuffer(credentialBuffer),
  );

  assert.equal(routing.batches.length, 2);
  assert.deepEqual(routing.batches[0].groups, ["IUMG", "BPH"]);
  assert.deepEqual(routing.batches[0].rows.map((item) => item.inputRowId), [2, 3]);
  assert.deepEqual(routing.batches[1].groups, ["Posada"]);
  assert.equal(routing.unmappedRows.length, 0);
});

test("keeps rows with missing credential mappings out of login batches", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        Group: "IUMG",
        URL: "https://shared.example.com",
        "User Name": "shared-user",
        Password: "shared-pass",
      },
    ]),
    "Credentials",
  );
  const credentialBuffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const unknownRow = { ...row(2, "M1", "01/01/2026"), group: "Unknown Group" };

  const routing = routeBlueShieldRowsByCredentials(
    [unknownRow],
    bufferToArrayBuffer(credentialBuffer),
  );

  assert.equal(routing.batches.length, 0);
  assert.deepEqual(routing.unmappedRows.map((item) => item.inputRowId), [2]);
});

test("creates a downloadable Blue Shield Excel error report", async () => {
  const buffer = await createBlueShieldErrorReportBuffer([
    {
      timestamp: "2026-07-09T12:00:00.000Z",
      member_id: "M100",
      dos: "07/01/2026",
      error_type: "credential_mapping",
      error_message: "Missing credentials for group TEST.",
      portal_url: "",
    },
  ]);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.getWorksheet("Blue Shield Errors");

  assert.ok(worksheet);
  assert.equal(worksheet.getRow(2).getCell(2).value, "M100");
  assert.equal(worksheet.getRow(2).getCell(4).value, "credential_mapping");
  assert.equal(worksheet.getRow(2).getCell(5).value, "Missing credentials for group TEST.");
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
