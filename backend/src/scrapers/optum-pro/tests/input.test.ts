import assert from "node:assert/strict";
import { test } from "node:test";
import * as XLSX from "xlsx";
import { readOptumProCredentialsFromBuffer, readOptumProInputRowsFromBuffer } from "../input";

function workbookBuffer(rows: Record<string, unknown>[]): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "Login");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

test("reads Optum Pro credentials from login workbook", () => {
  const credentials = readOptumProCredentialsFromBuffer(workbookBuffer([
    {
      "One Healthcare ID or Email Address": "user@example.test",
      Password: "secret",
      "Login URL": "pro.optum.com",
    },
  ]));

  assert.deepEqual(credentials, {
    loginUrl: "https://pro.optum.com",
    username: "user@example.test",
    password: "secret",
  });
});

test("reads Optum Pro claim rows with mandatory columns", () => {
  const rows = readOptumProInputRowsFromBuffer(workbookBuffer([
    {
      "Medical Group Name": "NAMM MEDICAL GROUP",
      Patient: "Isabel Bravo",
      DOS: "02/16/2026",
      CPT: "99204",
      "Member Id": "40028917901",
      "Extra Column": "keep allowed",
    },
  ]));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].medicalGroupName, "NAMM MEDICAL GROUP");
  assert.equal(rows[0].patient, "Isabel Bravo");
  assert.equal(rows[0].dos, "02/16/2026");
  assert.equal(rows[0].cpt, "99204");
  assert.equal(rows[0].memberId, "40028917901");
  assert.equal(rows[0].raw["Extra Column"], "keep allowed");
});

test("rejects Optum Pro claim rows missing mandatory values", () => {
  assert.throws(
    () => readOptumProInputRowsFromBuffer(workbookBuffer([
      {
        "Medical Group Name": "NAMM MEDICAL GROUP",
        Patient: "Isabel Bravo",
        DOS: "02/16/2026",
        CPT: "",
        "Member Id": "40028917901",
      },
    ])),
    /row 2: CPT/,
  );
});

test("requires Medical Group Name instead of generic Group Name", () => {
  assert.throws(
    () => readOptumProInputRowsFromBuffer(workbookBuffer([
      {
        "Group Name": "NAMM MEDICAL GROUP",
        Patient: "Isabel Bravo",
        DOS: "02/16/2026",
        CPT: "99204",
        "Member Id": "40028917901",
      },
    ])),
    /row 2: Medical Group Name/,
  );
});
