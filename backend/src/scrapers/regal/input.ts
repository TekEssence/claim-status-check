import * as XLSX from "xlsx";
import { loadRegalEnvironment } from "./env";

export type RegalCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

export type RegalInput = {
  credentials: RegalCredentials;
  claimRows: RegalClaimSearchInput[];
};

export type RegalClaimSearchInput = {
  rowNumber: number;
  group: string;
  memberName: string;
  dos: string;
};

const GROUP_ALIASES = ["Group", "Site", "Portal Group"];
const MEMBER_NAME_ALIASES = ["Member Name", "Member", "Patient Name"];
const DOS_ALIASES = ["DOS", "Date of Service", "Service Date"];

function normalizeHeader(value: unknown): string {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findColumnIndex(headers: unknown[], aliases: string[]): number {
  const normalizedAliases = aliases.map(normalizeHeader);
  return headers.findIndex((header) => normalizedAliases.includes(normalizeHeader(header)));
}

function parseClaimWorkbookRow(row: unknown[], rowNumber: number, indexes: { group: number; memberName: number; dos: number }): RegalClaimSearchInput {
  return {
    rowNumber,
    group: normalizeRegalGroup(row[indexes.group]),
    memberName: normalizeRegalMemberName(row[indexes.memberName]),
    dos: normalizeRegalInputDate(row[indexes.dos]),
  };
}

export function readRegalClaimRowsFromBuffer(buffer: ArrayBuffer): RegalClaimSearchInput[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error("Regal claim Excel does not contain a worksheet.");
  }

  const matrix = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
  }) as unknown[][];

  const firstRow = matrix[0] ?? [];
  const groupIndex = findColumnIndex(firstRow, GROUP_ALIASES);
  const memberNameIndex = findColumnIndex(firstRow, MEMBER_NAME_ALIASES);
  const dosIndex = findColumnIndex(firstRow, DOS_ALIASES);
  const hasHeader = groupIndex >= 0 || memberNameIndex >= 0 || dosIndex >= 0;

  const indexes = hasHeader
    ? { group: groupIndex, memberName: memberNameIndex, dos: dosIndex }
    : { group: -1, memberName: 0, dos: 1 };

  if (hasHeader && (indexes.group < 0 || indexes.memberName < 0 || indexes.dos < 0)) {
    throw new Error("Regal claim Excel must include Group, Member Name, and DOS columns.");
  }

  const rows = matrix
    .slice(hasHeader ? 1 : 0)
    .map((row, index) => parseClaimWorkbookRow(row, index + (hasHeader ? 2 : 1), indexes))
    .filter((row) => row.group || row.memberName || row.dos);

  const invalidRows = rows.filter((row) => !row.group || !row.memberName || !row.dos);
  if (invalidRows.length > 0) {
    throw new Error(
      `Regal claim Excel has ${invalidRows.length} incomplete row(s). Required columns are Group, Member Name, and DOS.`,
    );
  }

  return rows;
}

async function claimRowsFromWorkbook(file: File): Promise<RegalClaimSearchInput[]> {
  const buffer = await file.arrayBuffer();
  return readRegalClaimRowsFromBuffer(buffer);
}

function claimRowsFromEnv(): RegalClaimSearchInput[] {
  const row: RegalClaimSearchInput = {
    rowNumber: 0,
    group: normalizeRegalGroup(optionalEnv("REGAL_TEST_GROUP")),
    memberName: normalizeRegalMemberName(optionalEnv("REGAL_TEST_MEMBER_NAME")),
    dos: normalizeRegalInputDate(optionalEnv("REGAL_TEST_DOS")),
  };
  return row.group && row.memberName && row.dos ? [row] : [];
}

function asText(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${String(value.getMonth() + 1).padStart(2, "0")}/${String(value.getDate()).padStart(2, "0")}/${value.getFullYear()}`;
  }
  return value == null ? "" : String(value).trim();
}

function normalizeRegalInputDate(value: unknown): string {
  const text = asText(value);
  const match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return text;

  const [, monthText, dayText, yearText] = match;
  const year = yearText.length === 2 ? `20${yearText}` : yearText;
  return `${String(Number(monthText)).padStart(2, "0")}/${String(Number(dayText)).padStart(2, "0")}/${year}`;
}

export function normalizeRegalMemberName(value: unknown): string {
  const text = asText(value).replace(/\s+/g, " ").trim();
  if (!text) return "";

  const [lastNamePart, restPart = ""] = text.split(",", 2);
  const lastName = lastNamePart.trim();
  const restTokens = restPart.trim().split(/\s+/).filter(Boolean);

  if (!lastName || restTokens.length === 0) {
    return text;
  }

  const firstName = restTokens[0];
  const initial = restTokens.length > 1 ? restTokens[1].charAt(0) : "";
  return `${lastName},${firstName}${initial ? ` ${initial}` : ""}`;
}

export function normalizeRegalGroup(value: unknown): string {
  return asText(value).replace(/\s+/g, "").trim().toUpperCase();
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

export function readRegalCredentialsFromBuffer(buffer: ArrayBuffer): RegalCredentials | null {
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

async function credentialsFromWorkbook(file: File): Promise<RegalCredentials | null> {
  const buffer = await file.arrayBuffer();
  return readRegalCredentialsFromBuffer(buffer);
}

export async function parseRegalInput(formData: FormData): Promise<RegalInput> {
  loadRegalEnvironment();

  const claimExcel = formData.get("claimExcel");
  const claimRows = claimExcel instanceof File ? await claimRowsFromWorkbook(claimExcel) : claimRowsFromEnv();
  if (claimRows.length === 0) {
    throw new Error("Missing Regal claim Excel. Upload an Excel file with Group, Member Name, and DOS columns.");
  }

  const loginExcel = formData.get("loginExcel");
  if (loginExcel instanceof File) {
    const workbookCredentials = await credentialsFromWorkbook(loginExcel);
    if (workbookCredentials) {
      return { credentials: workbookCredentials, claimRows };
    }
  }

  const envCredentials = credentialsFromEnv();
  if (envCredentials) {
    return { credentials: envCredentials, claimRows };
  }

  throw new Error(
    "Missing Regal credentials. Provide REGAL_PORTAL_LOGIN_URL, REGAL_PORTAL_USERNAME, and REGAL_PORTAL_PASSWORD through env_path_regal, or upload a login Excel with URL, User Name, and Password columns.",
  );
}
