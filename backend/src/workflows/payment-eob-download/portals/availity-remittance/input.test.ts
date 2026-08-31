import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { normalizeCheckNumber, normalizeCheckNumberForComparison, normalizeTotpSecret, readAvailityRemittanceCredentials, readReferenceRows } from "./input";

const GOOGLE_AUTHENTICATOR_DATA_VALUE =
  "CnMKQMpxyRlBK7V3XEtbtGw2wbIXxBK%2Frq3qOdpQgOvynXsG1Xy4Y44HCE2TGNy2p8CMbe%2BCgnTvLKkADXvmTS3AetoSCnJjbWJyYW5kb24aCEF2YWlsaXR5IAEoATACQhNiYmM3NTQxNzgwMzIyNDkwMTI2EAIYASAA";

const GOOGLE_AUTHENTICATOR_SECRET =
  "ZJY4SGKBFO2XOXCLLO2GYNWBWIL4IEV7V2W6UOO2KCAOX4U5PMDNK7FYMOHAOCCNSMMNZNVHYCGG334CQJ2O6LFJAAGXXZSNFXAHVWQ";

async function workbookFile(name: string, rows: Array<Array<string | number | Date>>): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Sheet1");
  rows.forEach((row) => worksheet.addRow(row));
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([Buffer.from(buffer)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

async function workbookFileWithSheets(name: string, sheets: Array<{ name: string; rows: Array<Array<string | number | Date>> }>): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  sheets.forEach((sheet) => {
    const worksheet = workbook.addWorksheet(sheet.name);
    sheet.rows.forEach((row) => worksheet.addRow(row));
  });
  const buffer = await workbook.xlsx.writeBuffer();
  return new File([Buffer.from(buffer)], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

test("normalizes Check/EFT numbers without stripping leading zeros", () => {
  assert.equal(normalizeCheckNumber(" 0300191744 "), "0300191744");
  assert.equal(normalizeCheckNumber("1254526643.0"), "1254526643");
  assert.equal(normalizeCheckNumber("0900 562787"), "0900562787");
});

test("normalizes numeric Check/EFT comparison keys by removing leading zeros", () => {
  assert.equal(normalizeCheckNumberForComparison("000321780536"), "321780536");
  assert.equal(normalizeCheckNumberForComparison("09150603"), "9150603");
  assert.equal(normalizeCheckNumberForComparison("000312308014"), "312308014");
  assert.equal(normalizeCheckNumberForComparison("010009600834"), "10009600834");
  assert.equal(normalizeCheckNumberForComparison("3420955202"), "3420955202");
  assert.equal(normalizeCheckNumberForComparison("0000"), "0");
});

test("preserves alphanumeric Check/EFT zero structure while trimming and uppercasing", () => {
  assert.equal(normalizeCheckNumberForComparison(" AN0009070320 "), "AN0009070320");
  assert.equal(normalizeCheckNumberForComparison("5931435232wa6"), "5931435232WA6");
  assert.equal(normalizeCheckNumberForComparison("ww0009048872"), "WW0009048872");
});

test("matches numeric leading-zero variants using normalized comparison keys", () => {
  const trackerNumbers = new Set(["321780536", "09150603"].map(normalizeCheckNumberForComparison));
  assert.equal(trackerNumbers.has(normalizeCheckNumberForComparison("000321780536")), true);
  assert.equal(trackerNumbers.has(normalizeCheckNumberForComparison("9150603")), true);
  assert.equal(trackerNumbers.has(normalizeCheckNumberForComparison("000999")), false);
});

test("keeps plain base32 Availity TOTP secrets compatible with existing MFA helper", () => {
  assert.equal(normalizeTotpSecret(" JBSW Y3DPEHPK3PXP== "), "JBSWY3DPEHPK3PXP");
});

test("decodes Google Authenticator migration data into a base32 TOTP secret", () => {
  assert.equal(normalizeTotpSecret(GOOGLE_AUTHENTICATOR_DATA_VALUE), GOOGLE_AUTHENTICATOR_SECRET);
  assert.equal(
    normalizeTotpSecret(`otpauth-migration://offline?data=${GOOGLE_AUTHENTICATOR_DATA_VALUE}`),
    GOOGLE_AUTHENTICATOR_SECRET,
  );
});

test("reads Availity Remittance credentials from workbook aliases", async () => {
  const file = await workbookFile("credentials.xlsx", [
    ["User ID", "Password", "Secret Key", "Login URL", "Organization", "Lookback Days", "Tenant ID", "Client ID", "Client Secret", "SharePoint Site URL", "SharePoint Folder"],
    [
      "rcmben",
      "secret-password",
      "JBSWY3DPEHPK3PXP",
      "",
      "BENTONVILLE PEDIATRICS, P.A.",
      "20",
      "tenant-from-excel",
      "client-from-excel",
      "secret-from-excel",
      "https://contoso.sharepoint.com/sites/CH001_PEDI_BENT",
      "Documents/Payments Tracker/PaymentEobDownloads",
    ],
  ]);

  const credentials = await readAvailityRemittanceCredentials(file);

  assert.equal(credentials.username, "rcmben");
  assert.equal(credentials.password, "secret-password");
  assert.equal(credentials.totpSecret, "JBSWY3DPEHPK3PXP");
  assert.equal(credentials.organization, "BENTONVILLE PEDIATRICS, P.A.");
  assert.equal(credentials.lookbackDays, 20);
  assert.equal(credentials.project, "charm");
  assert.match(credentials.loginUrl, /^https:\/\/essentials\.availity\.com/);
  assert.deepEqual(credentials.sharePoint, {
    tenantId: "tenant-from-excel",
    clientId: "client-from-excel",
    clientSecret: "secret-from-excel",
    siteUrl: "https://contoso.sharepoint.com/sites/CH001_PEDI_BENT",
    folderPath: "Documents/Payments Tracker/PaymentEobDownloads",
  });
});

test("reads Availity Remittance credentials with Google Authenticator migration data", async () => {
  const file = await workbookFile("credentials.xlsx", [
    ["User ID", "Password", "Secret Key"],
    ["rcmben", "secret-password", GOOGLE_AUTHENTICATOR_DATA_VALUE],
  ]);

  const credentials = await readAvailityRemittanceCredentials(file);

  assert.equal(credentials.totpSecret, GOOGLE_AUTHENTICATOR_SECRET);
  assert.equal(credentials.lookbackDays, 10);
});

test("rejects invalid Payment EOB lookback day values", async () => {
  const file = await workbookFile("credentials.xlsx", [
    ["User ID", "Password", "Secret Key", "Lookback Days"],
    ["rcmben", "secret-password", "JBSWY3DPEHPK3PXP", "zero"],
  ]);

  await assert.rejects(
    () => readAvailityRemittanceCredentials(file),
    /Invalid Lookback Days value/,
  );
});

test("reads reference workbook Check/EFT numbers and dates", async () => {
  const file = await workbookFileWithSheets("reference.xlsx", [
    {
      name: "tracker",
      rows: [
        ["FD Number", "Check Date"],
        ["0300191744", "07/15/2026"],
        ["0900562787", new Date(Date.UTC(2026, 6, 15))],
      ],
    },
  ]);

  const rows = await readReferenceRows(file);

  assert.deepEqual(
    rows.map((row) => ({ checkNumber: row.checkNumber, checkDate: row.checkDate })),
    [
      { checkNumber: "0300191744", checkDate: "07/15/2026" },
      { checkNumber: "0900562787", checkDate: "07/15/2026" },
    ],
  );
});

test("reads reference workbook with exact Payment EOB column names", async () => {
  const file = await workbookFileWithSheets("reference.xlsx", [
    {
      name: "not tracker",
      rows: [
        ["Check/EFT #", "Check / EFT Date"],
        ["1111111111", "07/01/2026"],
      ],
    },
    {
      name: "tracker",
      rows: [
        ["Check/EFT #", "Check / EFT Date"],
        ["0900562787", "07/15/2026"],
      ],
    },
  ]);

  const rows = await readReferenceRows(file);

  assert.equal(rows[0].checkNumber, "0900562787");
  assert.equal(rows[0].checkDate, "07/15/2026");
});

test("reads MedRevenue routing and Pending EFT control-log fields", async () => {
  const credentialsFile = await workbookFile("credentials.xlsx", [
    ["User ID", "Password", "Secret Key", "Project", "Client Name"],
    ["user", "password", "JBSWY3DPEHPK3PXP", "Med Revenue", "Client A"],
  ]);
  const controlLog = await workbookFileWithSheets("control-log.xlsx", [{
    name: "tracker",
    rows: [
      ["Check/EFT #", "Entry Status", "Mode of Payment"],
      ["EFT-100", "Pending", "EFT"],
      ["EFT-200", "Complete", "EFT"],
    ],
  }]);

  const credentials = await readAvailityRemittanceCredentials(credentialsFile);
  const rows = await readReferenceRows(controlLog);

  assert.equal(credentials.project, "medrevenue");
  assert.equal(credentials.clientName, "Client A");
  assert.deepEqual(rows.map((row) => ({ checkNumber: row.checkNumber, entryStatus: row.entryStatus, modeOfPayment: row.modeOfPayment })), [
    { checkNumber: "EFT-100", entryStatus: "Pending", modeOfPayment: "EFT" },
    { checkNumber: "EFT-200", entryStatus: "Complete", modeOfPayment: "EFT" },
  ]);
});

test("requires a supported control-log worksheet", async () => {
  const file = await workbookFile("reference.xlsx", [
    ["Check/EFT #", "Check / EFT Date"],
    ["0900562787", "07/15/2026"],
  ]);

  await assert.rejects(
    () => readReferenceRows(file),
    /must contain a "tracker" or "Payments" worksheet/,
  );
});

test("accepts Payments as a control-log worksheet without removing tracker support", async () => {
  const file = await workbookFileWithSheets("control-log.xlsx", [{
    name: "Payments",
    rows: [
      ["Check/EFT #", "Entry Status", "Mode of Payment"],
      ["EFT-300", "Pending", "EFT"],
    ],
  }]);

  const rows = await readReferenceRows(file);

  assert.equal(rows[0].checkNumber, "EFT-300");
  assert.equal(rows[0].entryStatus, "Pending");
  assert.equal(rows[0].modeOfPayment, "EFT");
});
