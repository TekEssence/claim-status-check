import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { findWaystarCredentialsForPayer, readWaystarCredentialProfiles, readWaystarCredentials } from "../credentials";

function workbookFile(options: {
  credentialsRows: Record<string, unknown>[];
  verificationRows?: Record<string, unknown>[];
}): File {
  const workbook = XLSX.utils.book_new();
  const credentialSheet = XLSX.utils.json_to_sheet(options.credentialsRows);
  XLSX.utils.book_append_sheet(workbook, credentialSheet, "Sheet1");

  if (options.verificationRows) {
    const verificationSheet = XLSX.utils.json_to_sheet(options.verificationRows);
    XLSX.utils.book_append_sheet(workbook, verificationSheet, "verification");
  }

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return new File([buffer], "credentials.xlsx");
}

test("reads Waystar credentials and verification answers from workbook", async () => {
  const file = workbookFile({
    credentialsRows: [
      {
        URL: "https://portal.example.com/login",
        Username: "demo-user",
        Password: "demo-pass",
        "Provider Name": "PINELLAS COUNTY PRIMARY CARE AND HOSPITALISTS",
        "Service Type Code": "30 - Health Benefit Plan Coverage",
      },
    ],
    verificationRows: [
      {
        Question: "What was the first car you owned?",
        Answer: "Dzire",
      },
      {
        Question: "First Job",
        Answer: "Biller",
      },
    ],
  });

  const credentials = await readWaystarCredentials(file);
  assert.equal(credentials.loginUrl, "https://portal.example.com/login");
  assert.equal(credentials.username, "demo-user");
  assert.equal(credentials.password, "demo-pass");
  assert.equal(credentials.providerName, "PINELLAS COUNTY PRIMARY CARE AND HOSPITALISTS");
  assert.equal(credentials.serviceTypeCode, "30");
  assert.deepEqual(credentials.verificationAnswers, [
    { question: "What was the first car you owned?", answer: "Dzire" },
    { question: "First Job", answer: "Biller" },
  ]);
});

test("selects the credential row matching the routed payer", async () => {
  const profiles = await readWaystarCredentialProfiles(workbookFile({
    credentialsRows: [
      { URL: "https://waystar.example.com", "User Name": "med-user", Password: "med-pass", Portal: "Waystar", Payer: "Medicare" },
      { URL: "https://waystar.example.com", "User Name": "bcbs-user", Password: "bcbs-pass", Portal: "Waystar", Payer: "Blue Cross Blue Shield Texas" },
    ],
  }));

  const selected = findWaystarCredentialsForPayer(profiles, {
    id: "blue-cross-blue-shield-texas",
    name: "Blue Cross Blue Shield Texas",
    portalPayerName: "BCBS Texas(SB900)",
    insuranceNameAliases: ["bcbs texas", "bcbstx"],
  });

  assert.equal(selected?.username, "bcbs-user");
  assert.equal(selected?.payer, "Blue Cross Blue Shield Texas");
});

test("does not silently use another payer credential row", async () => {
  const profiles = await readWaystarCredentialProfiles(workbookFile({
    credentialsRows: [
      { URL: "https://waystar.example.com", "User Name": "med-user", Password: "med-pass", Portal: "Waystar", Payer: "Medicare" },
      { URL: "https://waystar.example.com", "User Name": "fl-user", Password: "fl-pass", Portal: "Waystar", Payer: "BCBS Florida" },
    ],
  }));

  const selected = findWaystarCredentialsForPayer(profiles, {
    id: "blue-cross-blue-shield-texas",
    name: "Blue Cross Blue Shield Texas",
    portalPayerName: "BCBS Texas(SB900)",
    insuranceNameAliases: ["bcbs texas", "bcbstx"],
  });

  assert.equal(selected, null);
});
