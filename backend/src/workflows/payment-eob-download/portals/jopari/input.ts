import ExcelJS from "exceljs";
import type { PaymentEobCredentials } from "../../types";

const DEFAULT_LOGIN_URL = "https://rg.jopari.net";

function text(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return `${value.getUTCMonth() + 1}/${value.getUTCDate()}/${value.getUTCFullYear()}`;
  if (typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  if (typeof value === "object" && "result" in value) return text((value as { result?: unknown }).result);
  return String(value).trim();
}

function key(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueFor(row: Record<string, string>, aliases: string[]): string {
  const wanted = new Set(aliases.map(key));
  return Object.entries(row).find(([header, value]) => wanted.has(key(header)) && value.trim())?.[1].trim() ?? "";
}

async function workbookRows(file: File): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const rows: Record<string, string>[] = [];
  for (const sheet of workbook.worksheets) {
    let headerRow = 0;
    const headers: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRow) return;
      const values = row.values as unknown[];
      if (values.some((value) => /login|user|password|check|file\s*name/i.test(text(value)))) {
        headerRow = rowNumber;
        row.eachCell({ includeEmpty: true }, (cell, column) => { headers[column] = text(cell.value); });
      }
    });
    if (!headerRow) continue;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const data: Record<string, string> = {};
      headers.forEach((header, column) => { if (header) data[header] = text(row.getCell(column).value); });
      if (Object.values(data).some(Boolean)) rows.push(data);
    });
  }
  return rows;
}

export async function readJopariCredentials(file: File): Promise<PaymentEobCredentials> {
  const rows = await workbookRows(file);
  for (const row of rows) {
    const username = valueFor(row, ["Login ID", "Login", "Username", "User ID"]);
    const password = valueFor(row, ["Password"]);
    if (!username || !password) continue;
    const rawDays = valueFor(row, ["Lookback Days", "Days Back", "Last N Days", "Date Range Days"]);
    const lookbackDays = rawDays ? Number.parseInt(rawDays.replace(/\D/g, ""), 10) : 30;
    if (!Number.isFinite(lookbackDays) || lookbackDays <= 0) throw new Error(`Invalid Jopari Lookback Days value "${rawDays}".`);
    const rawUrl = valueFor(row, ["Link", "URL", "Login URL", "Portal Link"]);
    return {
      loginUrl: rawUrl ? (rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`) : DEFAULT_LOGIN_URL,
      username,
      password,
      totpSecret: "",
      lookbackDays,
    };
  }
  throw new Error("Missing Jopari credentials. Credential Excel must contain Login ID (or Username) and Password.");
}

export type JopariControlReference = {
  checkNumbers: Set<string>;
  fileNames: string[];
};

export function normalizeJopariIdentifier(value: unknown): string {
  const normalized = text(value).toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return /^\d+$/.test(normalized) ? normalized.replace(/^0+(?=\d)/, "") : normalized;
}

export async function readJopariControlLog(file: File): Promise<JopariControlReference> {
  const rows = await workbookRows(file);
  const checkNumbers = new Set<string>();
  const fileNames: string[] = [];
  for (const row of rows) {
    const check = normalizeJopariIdentifier(valueFor(row, ["Check number", "Check #", "Check/EFT #", "EFT/Check #"]));
    const fileName = valueFor(row, ["File Name", "Filename"]);
    if (check) checkNumbers.add(check);
    if (fileName) fileNames.push(normalizeJopariIdentifier(fileName));
  }
  if (!checkNumbers.size && !fileNames.length) throw new Error("Control Log must contain Check number and/or File Name values.");
  return { checkNumbers, fileNames };
}
