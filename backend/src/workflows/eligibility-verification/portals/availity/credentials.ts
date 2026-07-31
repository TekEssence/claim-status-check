import ExcelJS from "exceljs";

export type AvailityEligibilityCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  totpSecret: string;
  successUrlFragment: string;
};

const AVAILITY_ELIGIBILITY_PROJECT = "tpm";
const AVAILITY_ELIGIBILITY_PORTAL = "availity";

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value).trim();
}

function normalizeAlias(value: unknown): string {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findValue(row: Record<string, string>, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalizeAlias));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeAlias(key)) && value) return value.trim();
  }
  return "";
}

export async function readAvailityEligibilityCredentials(
  credentialFile: File,
): Promise<AvailityEligibilityCredentials> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await credentialFile.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Availity login workbook does not contain a worksheet.");

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
    headers[column] = asText(cell.value);
  });

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const worksheetRow = worksheet.getRow(rowNumber);
    const row: Record<string, string> = {};
    headers.forEach((header, column) => {
      if (header) row[header] = asText(worksheetRow.getCell(column).value);
    });

    const project = findValue(row, ["Project"]);
    const portal = findValue(row, ["Portal"]);
    if (
      project.toLowerCase() !== AVAILITY_ELIGIBILITY_PROJECT
      || portal.toLowerCase() !== AVAILITY_ELIGIBILITY_PORTAL
    ) {
      continue;
    }

    const rawLoginUrl = findValue(row, ["Link", "URL", "Login URL", "Portal Link", "LOGIN_URL_AVA"]);
    const username = findValue(row, ["Username", "User Name", "User ID", "USERNAME_AVA1"]);
    const password = findValue(row, ["Password", "PASSWORD_AVA1"]);
    const totpSecret = findValue(row, ["Secret Key", "Secret", "TOTP Secret", "TOTP_SECRET"]);
    const successUrlFragment = findValue(row, ["Success URL Fragment", "SUCCESS_URL_FRAGMENT"]);

    if (rawLoginUrl && username && password && totpSecret) {
      return {
        loginUrl: rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`,
        username,
        password,
        totpSecret,
        successUrlFragment,
      };
    }
  }

  throw new Error(
    "Missing TPM Availity login details. The credential workbook must contain a row with Project TPM, Portal Availity, Link, Username, Password, and Secret Key.",
  );
}
