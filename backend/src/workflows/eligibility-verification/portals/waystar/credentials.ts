import * as XLSX from "xlsx";
import { credentialProjectMatches, type EligibilityProjectId } from "../../projects";

export type WaystarSecurityQuestion = {
  username?: string;
  question: string;
  answer: string;
};

export type WaystarCredentials = {
  portal?: string;
  payer?: string;
  project?: string;
  loginUrl: string;
  username: string;
  password: string;
  providerId?: string;
  providerName?: string;
  serviceTypeCode: string;
  verificationAnswers: WaystarSecurityQuestion[];
};

const DEFAULT_LOGIN_URL = "https://www.waystar.com/";
const DEFAULT_SERVICE_TYPE_CODE = "30";

export async function readWaystarCredentials(file: File): Promise<WaystarCredentials> {
  const credentials = await readWaystarCredentialProfiles(file);
  return credentials[0];
}

export async function readWaystarCredentialProfiles(file: File): Promise<WaystarCredentials[]> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error("The Waystar credential workbook does not contain a worksheet.");
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  const verificationAnswers = readVerificationSheet(workbook);
  const credentials = rows.flatMap((row): WaystarCredentials[] => {
    const rawLoginUrl = findValue(row, ["url", "login url", "portal url", "waystar login url"]);
    const username = findValue(row, ["user name", "username", "login name", "waystar username"]);
    const password = findValue(row, ["password", "waystar password"]);
    if (!username || !password) return [];

    return [{
      portal: findValue(row, ["portal", "portal name"]),
      payer: findValue(row, ["payer", "payer name", "insurance", "insurance name"]),
      project: findValue(row, ["project", "project name"]),
      loginUrl: normalizeLoginUrl(rawLoginUrl || DEFAULT_LOGIN_URL),
      username,
      password,
      providerId: findValue(row, ["selectedproviderid", "provider id"]),
      providerName: findValue(row, ["provider", "provider name", "selected provider"]),
      serviceTypeCode: normalizeServiceTypeCode(
        findValue(row, ["service type code", "service type", "ddlstccode"]) || DEFAULT_SERVICE_TYPE_CODE,
      ),
      verificationAnswers: verificationAnswers.filter((entry) =>
        !entry.username || normalizeHeader(entry.username) === normalizeHeader(username),
      ),
    }];
  });

  if (credentials.length > 0) return credentials;

  throw new Error(
    "Missing Waystar credentials. Upload a credential workbook with URL, User Name, Password, Portal, and Payer columns.",
  );
}

export function findWaystarCredentialsForPayer(
  credentials: WaystarCredentials[],
  payer: { id: string; name: string; portalPayerName: string; insuranceNameAliases: string[]; credentialProject?: string },
  projectId: EligibilityProjectId = "minimax",
): WaystarCredentials | null {
  const projectCredentials = projectId === "minimax"
    // Preserve every legacy Minimax project/group credential (including FL2
    // and blank values) while explicitly excluding the new project boundary.
    ? credentials.filter((entry) => !credentialProjectMatches("medrevenue", entry.project))
    : credentials.filter((entry) => credentialProjectMatches(projectId, entry.project));
  const portalMatches = projectCredentials.filter((entry) => (!entry.portal || normalizeHeader(entry.portal).includes("waystar")) && (projectId !== "minimax" || !payer.credentialProject || normalizeHeader(entry.project ?? "") === normalizeHeader(payer.credentialProject)));
  const exact = portalMatches.find((entry) => {
    const credentialPayer = normalizeHeader(entry.payer ?? "");
    if (!credentialPayer) return false;
    return [payer.id, payer.name, payer.portalPayerName, ...payer.insuranceNameAliases]
      .map(normalizeHeader)
      .some((candidate) => credentialPayer === candidate || credentialPayer.includes(candidate) || candidate.includes(credentialPayer));
  });
  if (exact) return exact;
  if (payer.credentialProject && portalMatches.length > 0) return portalMatches[0];

  const unscoped = portalMatches.filter((entry) => !entry.payer);
  return projectCredentials.length === 1 && unscoped.length === 1 ? unscoped[0] : null;
}

function readVerificationSheet(workbook: XLSX.WorkBook): WaystarSecurityQuestion[] {
  const sheetName = workbook.SheetNames.find((name) => normalizeHeader(name) === "verification");
  if (!sheetName) return [];

  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  return rows
    .map((row) => ({
      username: findValue(row, ["user name", "username", "login name", "waystar username"]) || undefined,
      question: findValue(row, ["question", "security question", "verification question"]),
      answer: findValue(row, ["answer", "security answer", "verification answer"]),
    }))
    .filter((entry) => entry.question && entry.answer);
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (!normalizedAliases.has(normalizeHeader(key))) continue;
    const text = asText(value);
    if (text) return text;
  }
  return "";
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeLoginUrl(rawLoginUrl: string): string {
  if (!rawLoginUrl) return DEFAULT_LOGIN_URL;
  return rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`;
}

function normalizeServiceTypeCode(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^([A-Za-z0-9]{1,3})\b/);
  return match ? match[1].toUpperCase() : DEFAULT_SERVICE_TYPE_CODE;
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}
