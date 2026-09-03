import ExcelJS from "exceljs";
import { credentialProjectMatches, type EligibilityProjectId } from "../../projects";

export type AvailityEligibilityCredentials = {
  payer?: string;
  loginUrl: string;
  username: string;
  password: string;
  totpSecret: string;
  successUrlFragment: string;
};

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

export async function readAvailityEligibilityCredentialProfiles(
  credentialFile: File,
  projectId: EligibilityProjectId = "minimax",
): Promise<AvailityEligibilityCredentials[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await credentialFile.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Availity login workbook does not contain a worksheet.");

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
    headers[column] = asText(cell.value);
  });

  const profiles: AvailityEligibilityCredentials[] = [];
  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const worksheetRow = worksheet.getRow(rowNumber);
    const row: Record<string, string> = {};
    headers.forEach((header, column) => {
      if (header) row[header] = asText(worksheetRow.getCell(column).value);
    });

    const project = findValue(row, ["Project"]);
    const portal = findValue(row, ["Portal"]);
    if (
      !credentialProjectMatches(projectId, project)
      || portal.toLowerCase() !== AVAILITY_ELIGIBILITY_PORTAL
    ) continue;

    const rawLoginUrl = findValue(row, ["Link", "URL", "Login URL", "Portal Link", "LOGIN_URL_AVA"]);
    const username = findValue(row, ["Username", "User Name", "User ID", "USERNAME_AVA1"]);
    const password = findValue(row, ["Password", "PASSWORD_AVA1"]);
    const totpSecret = findValue(row, ["Secret Key", "Secret", "TOTP Secret", "TOTP_SECRET"]);
    const successUrlFragment = findValue(row, ["Success URL Fragment", "SUCCESS_URL_FRAGMENT"]);
    const payer = findValue(row, ["Payer", "Payer Name", "Insurance", "Insurance Name"]);

    if (rawLoginUrl && username && password && totpSecret) {
      profiles.push({
        payer: payer || undefined,
        loginUrl: rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`,
        username,
        password,
        totpSecret,
        successUrlFragment,
      });
    }
  }

  if (profiles.length) return profiles;
  throw new Error(
    `Missing ${projectId === "minimax" ? "Minimax/TPM" : "MedRevenue"} Availity login details. The credential workbook Project column must match the selected project.`,
  );
}

export function findAvailityEligibilityCredentialsForPayer(
  profiles: AvailityEligibilityCredentials[],
  payerId: string,
  payerName: string,
): AvailityEligibilityCredentials | null {
  const candidates = [payerId, payerName].map(normalizeAlias);
  const exact = profiles.find((profile) => {
    const payer = normalizeAlias(profile.payer);
    return payer && candidates.some(
      (candidate) => payer === candidate || payer.includes(candidate) || candidate.includes(payer),
    );
  });
  if (exact) return exact;

  const shared = profiles.filter((profile) => !profile.payer);
  if (shared.length === 1) return shared[0];
  return profiles.length === 1 ? profiles[0] : null;
}

export async function readAvailityEligibilityCredentials(
  credentialFile: File,
  projectId: EligibilityProjectId = "minimax",
): Promise<AvailityEligibilityCredentials> {
  return (await readAvailityEligibilityCredentialProfiles(credentialFile, projectId))[0];
}
