import * as XLSX from "xlsx";

export type WaystarSecurityQuestion = {
  question: string;
  answer: string;
};

export type WaystarCredentials = {
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
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error("The Waystar credential workbook does not contain a worksheet.");
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  for (const row of rows) {
    const rawLoginUrl = findValue(row, ["url", "login url", "portal url", "waystar login url"]);
    const username = findValue(row, ["user name", "username", "login name", "waystar username"]);
    const password = findValue(row, ["password", "waystar password"]);
    if (!username || !password) continue;

    return {
      loginUrl: normalizeLoginUrl(rawLoginUrl || DEFAULT_LOGIN_URL),
      username,
      password,
      providerId: findValue(row, ["selectedproviderid", "provider id"]),
      providerName: findValue(row, ["provider", "provider name", "selected provider"]),
      serviceTypeCode: normalizeServiceTypeCode(
        findValue(row, ["service type code", "service type", "ddlstccode"]) || DEFAULT_SERVICE_TYPE_CODE,
      ),
      verificationAnswers: readVerificationSheet(workbook),
    };
  }

  throw new Error(
    "Missing Waystar credentials. Upload a credential workbook with User Name/Username and Password columns.",
  );
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
