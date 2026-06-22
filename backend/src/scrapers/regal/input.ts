import * as XLSX from "xlsx";
import { loadRegalEnvironment } from "./env";

export type RegalCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

export type RegalInput = {
  credentials: RegalCredentials;
};

function asText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function optionalEnv(name: string): string {
  return asText(process.env[name]);
}

function normalizeLoginUrl(rawLoginUrl: string): string {
  return rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`;
}

function credentialsFromEnv(): RegalCredentials | null {
  loadRegalEnvironment();
  const rawLoginUrl = optionalEnv("REGAL_PORTAL_LOGIN_URL");
  const username = optionalEnv("REGAL_PORTAL_USERNAME");
  const password = optionalEnv("REGAL_PORTAL_PASSWORD");

  if (!rawLoginUrl || !username || !password) {
    return null;
  }

  return {
    loginUrl: normalizeLoginUrl(rawLoginUrl),
    username,
    password,
  };
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const normalizedAliases = aliases.map((alias) => alias.trim().toLowerCase());
  for (const [key, value] of Object.entries(row)) {
    if (normalizedAliases.includes(key.trim().toLowerCase())) {
      const text = asText(value);
      if (text) return text;
    }
  }
  return "";
}

async function credentialsFromWorkbook(file: File): Promise<RegalCredentials | null> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
  for (const row of rows) {
    const rawLoginUrl = findValue(row, ["URL", "Login URL", "REGAL_PORTAL_LOGIN_URL"]);
    const username = findValue(row, ["User Name", "Username", "REGAL_PORTAL_USERNAME"]);
    const password = findValue(row, ["Password", "REGAL_PORTAL_PASSWORD"]);

    if (rawLoginUrl && username && password) {
      return {
        loginUrl: normalizeLoginUrl(rawLoginUrl),
        username,
        password,
      };
    }
  }

  return null;
}

export async function parseRegalInput(formData: FormData): Promise<RegalInput> {
  loadRegalEnvironment();

  const envCredentials = credentialsFromEnv();
  if (envCredentials) {
    return { credentials: envCredentials };
  }

  const loginExcel = formData.get("loginExcel");
  if (loginExcel instanceof File) {
    const workbookCredentials = await credentialsFromWorkbook(loginExcel);
    if (workbookCredentials) {
      return { credentials: workbookCredentials };
    }
  }

  throw new Error(
    "Missing Regal credentials. Provide REGAL_PORTAL_LOGIN_URL, REGAL_PORTAL_USERNAME, and REGAL_PORTAL_PASSWORD through env_path_regal, or upload a login Excel with URL, User Name, and Password columns.",
  );
}
