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
    { username: undefined, question: "What was the first car you owned?", answer: "Dzire" },
    { username: undefined, question: "First Job", answer: "Biller" },
  ]);
});

test("scopes verification answers to the matching username", async () => {
  const profiles = await readWaystarCredentialProfiles(workbookFile({
    credentialsRows: [
      { Username: "user-one", Password: "pass-one" },
      { Username: "user-two", Password: "pass-two" },
    ],
    verificationRows: [
      { Username: "user-one", Question: "First Job", Answer: "Biller" },
      { Username: "user-two", Question: "First Job", Answer: "Nurse" },
    ],
  }));

  assert.deepEqual(profiles[0].verificationAnswers, [
    { username: "user-one", question: "First Job", answer: "Biller" },
  ]);
  assert.deepEqual(profiles[1].verificationAnswers, [
    { username: "user-two", question: "First Job", answer: "Nurse" },
  ]);
});
test("selects the credential row matching the routed payer", async () => {
  const profiles = await readWaystarCredentialProfiles(workbookFile({
    credentialsRows: [
      { URL: "https://waystar.example.com", "User Name": "med-user", Password: "med-pass", Portal: "Waystar", Payer: "Medicare" },
      { URL: "https://waystar.example.com", "User Name": "bcbs-user", Password: "bcbs-pass", Portal: "Waystar", Payer: "BCBS PPO" },
    ],
  }));

  const selected = findWaystarCredentialsForPayer(profiles, {
    id: "bcbs-ppo",
    name: "BCBS PPO",
    portalPayerName: "BCBS Florida (SB590)",
    insuranceNameAliases: ["bcbs ppo"],
  });

  assert.equal(selected?.username, "bcbs-user");
  assert.equal(selected?.payer, "BCBS PPO");
});

test("does not silently use another payer credential row", async () => {
  const profiles = await readWaystarCredentialProfiles(workbookFile({
    credentialsRows: [
      { URL: "https://waystar.example.com", "User Name": "med-user", Password: "med-pass", Portal: "Waystar", Payer: "Medicare" },
      { URL: "https://waystar.example.com", "User Name": "fl-user", Password: "fl-pass", Portal: "Waystar", Payer: "BCBS Texas" },
    ],
  }));

  const selected = findWaystarCredentialsForPayer(profiles, {
    id: "bcbs-ppo",
    name: "BCBS PPO",
    portalPayerName: "BCBS Florida (SB590)",
    insuranceNameAliases: ["bcbs ppo"],
  });

  assert.equal(selected, null);
});
