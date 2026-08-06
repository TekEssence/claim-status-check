import ExcelJS from "exceljs";
import type { PaymentPostingCredentials } from "../../types";

const DEFAULT_LOGIN_URL = "https://login.advancedmd.com/";

const FIELD_ALIASES = {
  loginUrl: ["Login URL", "URL", "Portal URL", "AdvancedMD URL"],
  username: ["Username", "User Name", "User ID", "Email", "Login", "Login Name", "Login name"],
  password: ["Password"],
  officeKey: ["Office Key", "Office key", "OfficeKey"],
  practice: ["Practice", "Practice Name"],
  office: ["Office", "Office Name", "Location"],
  provider: ["Provider", "Provider Name"],
} as const;

export type AdvancedMdPaymentPostingCredentials = PaymentPostingCredentials & {
  officeKey?: string;
};

export async function readAdvancedMdCredentials(file: File): Promise<AdvancedMdPaymentPostingCredentials> {
  const rows = await readWorkbookRows(file);
  for (const row of rows) {
    const username = findValue(row, FIELD_ALIASES.username);
    const password = findValue(row, FIELD_ALIASES.password);
    if (!username || !password) continue;

    return {
      loginUrl: normalizeLoginUrl(findValue(row, FIELD_ALIASES.loginUrl) || DEFAULT_LOGIN_URL),
      username,
      password,
      officeKey: findValue(row, FIELD_ALIASES.officeKey) || undefined,
      practice: findValue(row, FIELD_ALIASES.practice) || undefined,
      office: findValue(row, FIELD_ALIASES.office) || undefined,
      provider: findValue(row, FIELD_ALIASES.provider) || undefined,
      raw: row,
    };
  }

  throw new Error("Missing AdvancedMD credentials. Upload a credential workbook with Username/User ID/Email and Password columns.");
}

async function readWorkbookRows(file: File): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("The AdvancedMD credential workbook does not contain a worksheet.");

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = asText(cell.value).replace(/\s+/g, " ").trim();
  });

  const rows: Record<string, string>[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const data: Record<string, string> = {};
    headers.forEach((header, colNumber) => {
      if (header) data[header] = asText(row.getCell(colNumber).value);
    });
    if (Object.values(data).some(Boolean)) rows.push(data);
  });
  return rows;
}

function findValue(row: Record<string, string>, aliases: readonly string[]): string {
  const wanted = new Set(aliases.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeHeader(key)) && value.trim()) return value.trim();
  }
  return "";
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function normalizeLoginUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_LOGIN_URL;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function asText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  if (typeof value === "object" && "result" in value) return asText((value as { result?: unknown }).result);
  return String(value).trim();
}
