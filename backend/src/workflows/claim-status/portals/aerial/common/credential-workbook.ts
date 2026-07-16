import * as XLSX from "xlsx";
import type { AerialCredentials, AerialSubportalDefinition } from "./subportal";
import { normalizeAerialSubportalName } from "./subportal";

function asText(value: unknown): string {
  return value == null ? "" : String(value).trim();
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

function normalizeLoginUrl(rawLoginUrl: string): string {
  return rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`;
}

export function loadCredentialsForAerialSubportal(
  buffer: ArrayBuffer,
  subportal: AerialSubportalDefinition,
): AerialCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  const aliases = subportal.aliases.map(normalizeAerialSubportalName);
  const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
  let legacyCredentials: AerialCredentials | null = null;

  for (const row of rows) {
    const rowSubportalText = findValue(row, ["Sub portal", "Subportal", "Portal"]);
    const rowSubportal = normalizeAerialSubportalName(rowSubportalText);
    const rawLoginUrl = findValue(row, ["URL", "Login URL", "Aerial URL", "PORTAL_AERIAL_LOGIN_URL"]);
    const username = findValue(row, ["User Name", "Username", "PORTAL_AERIAL_USERNAME"]);
    const password = findValue(row, ["Password", "PORTAL_AERIAL_PASSWORD"]);

    if (!rawLoginUrl || !username || !password) continue;

    const credentials: AerialCredentials = {
      loginUrl: normalizeLoginUrl(rawLoginUrl),
      username,
      password,
      claimsUrl: findValue(row, ["Claims URL", "PORTAL_AERIAL_CLAIMS_URL"]),
      successUrlFragment: findValue(row, ["Success URL Fragment", "PORTAL_AERIAL_SUCCESS_URL_FRAGMENT"]),
    };

    if (aliases.includes(rowSubportal)) return credentials;

    if (subportal.allowLegacyUnscopedCredentials && !rowSubportalText && !legacyCredentials) {
      legacyCredentials = credentials;
    }
  }

  return legacyCredentials;
}
