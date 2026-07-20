import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { loadAerialCredentialsFromWorkbook, type AerialSubportal } from "../input";
import { resolveAerialSubportal } from "../subportals/registry";

function credentialWorkbookBuffer(rows: Array<Record<string, string | undefined>>): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Credentials");
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

function readCredentials(rows: Array<Record<string, string | undefined>>, subportal: AerialSubportal) {
  return loadAerialCredentialsFromWorkbook(credentialWorkbookBuffer(rows), subportal);
}

function readGroupCredentials(rows: Array<Record<string, string | undefined>>, group: string, subportal: AerialSubportal = "citrus-valley") {
  return loadAerialCredentialsFromWorkbook(credentialWorkbookBuffer(rows), subportal, group);
}

test("Aerial selects only the requested subportal credential row", () => {
  const rows = [
    { "Sub portal": "PMG", "Login URL": "https://pmg.example/login", Username: "pmg-user", Password: "pmg-secret" },
    { "Sub portal": "Citrus Valley", "Login URL": "https://citrus.example/login", Username: "citrus-user", Password: "citrus-secret" },
  ];

  assert.deepEqual(readCredentials(rows, "pmg"), {
    loginUrl: "https://pmg.example/login",
    username: "pmg-user",
    password: "pmg-secret",
    claimsUrl: "",
    successUrlFragment: "",
  });
  assert.deepEqual(readCredentials(rows, "citrus-valley"), {
    loginUrl: "https://citrus.example/login",
    username: "citrus-user",
    password: "citrus-secret",
    claimsUrl: "",
    successUrlFragment: "",
  });
});

test("Aerial subportal matching ignores case, spacing, underscores, and hyphens", () => {
  const rows = [
    { "Sub portal": "  CITRUS_valley  ", "Login URL": "citrus.example/login", Username: "user", Password: "secret" },
  ];

  assert.equal(readCredentials(rows, "citrus-valley")?.loginUrl, "https://citrus.example/login");
});

test("PMG keeps support for legacy unscoped credential workbooks", () => {
  const rows = [
    { "Login URL": "https://legacy-pmg.example/login", Username: "legacy-user", Password: "legacy-secret" },
  ];

  assert.equal(readCredentials(rows, "pmg")?.username, "legacy-user");
});

test("Citrus Valley never falls back to PMG or an unscoped credential row", () => {
  const rows = [
    { "Sub portal": "PMG", "Login URL": "https://pmg.example/login", Username: "pmg-user", Password: "pmg-secret" },
    { "Login URL": "https://legacy-pmg.example/login", Username: "legacy-user", Password: "legacy-secret" },
  ];

  assert.equal(readCredentials(rows, "citrus-valley"), null);
});

test("Citrus Valley selects credentials primarily by normalized Group", () => {
  const rows = [
    { Group: "IPPS", "Login URL": "https://ipps.example/login", Username: "ipps-user", Password: "ipps-secret" },
    { Group: "BZA", "Login URL": "https://bza.example/login", Username: "bza-user", Password: "bza-secret" },
  ];

  assert.equal(readGroupCredentials(rows, " ipps ")?.username, "ipps-user");
  assert.equal(readGroupCredentials(rows, "B-Z-A")?.username, "bza-user");
  assert.equal(readGroupCredentials(rows, "UNKNOWN"), null);
});

test("Aerial isolates identical Groups by Sub portal and Group", () => {
  const rows = [
    { "Sub portal": "PMG", Group: "IPMG", "Login URL": "https://pmg.example/login", Username: "pmg-ipmg", Password: "pmg-secret" },
    { "Sub portal": "Citrus Valley", Group: "IPMG", "Login URL": "https://citrus.example/login", Username: "citrus-ipmg", Password: "citrus-secret" },
    { "Sub portal": "Citrus Valley", Group: "IPHS", "Login URL": "https://iphs.example/login", Username: "citrus-iphs", Password: "iphs-secret" },
  ];

  assert.equal(readGroupCredentials(rows, "IPMG", "pmg")?.username, "pmg-ipmg");
  assert.equal(readGroupCredentials(rows, "IPMG", "citrus-valley")?.username, "citrus-ipmg");
  assert.equal(readGroupCredentials(rows, "IPHS", "citrus-valley")?.username, "citrus-iphs");
});

test("Aerial backend router preserves PMG as the legacy default", () => {
  assert.equal(resolveAerialSubportal(null).id, "pmg");
  assert.equal(resolveAerialSubportal("").id, "pmg");
});

test("Aerial backend router sends Citrus Valley to its separate module", () => {
  assert.equal(resolveAerialSubportal("Citrus Valley").id, "citrus-valley");
  assert.equal(resolveAerialSubportal("citrus-valley").id, "citrus-valley");
});
