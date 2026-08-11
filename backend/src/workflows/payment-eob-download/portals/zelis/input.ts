import ExcelJS from "exceljs";
import type { PaymentEobCredentials } from "../../types";
import { normalizeTotpSecret, readReferenceRows } from "../availity-remittance/input";
import { zelisConfig } from "./config";

function asText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return `${String(value.getUTCMonth() + 1).padStart(2, "0")}/${String(value.getUTCDate()).padStart(2, "0")}/${value.getUTCFullYear()}`;
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  if (typeof value === "object" && "result" in value) {
    return asText((value as { result?: unknown }).result);
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

function normalizeLoginUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return zelisConfig.defaultLoginUrl;
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

async function readWorkbookRows(file: File): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(`${file.name || "Credential workbook"} does not contain any worksheets.`);
  }

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

export async function readZelisCredentials(file: File): Promise<PaymentEobCredentials> {
  const rows = await readWorkbookRows(file);
  for (const row of rows) {
    const username = findValue(row, ["User Name", "Username", "User ID", "Zelis User Name", "Zelis Username"]);
    const password = findValue(row, ["Password", "Zelis Password"]);
    const totpSecret = normalizeTotpSecret(findValue(row, [
      "Secret Key",
      "Secret",
      "TOTP Secret",
      "Google Authenticator Data",
      "Authenticator Migration Data",
      "Migration Data",
    ]));
    if (!username || !password || !totpSecret) continue;

    return {
      loginUrl: normalizeLoginUrl(findValue(row, ["Link", "URL", "Login URL", "Portal Link", "Zelis URL"])),
      username,
      password,
      totpSecret,
      lookbackDays: 30,
    };
  }

  throw new Error("Missing Zelis credentials. Credential Excel must contain User Name, Password, and Secret Key.");
}

export { readReferenceRows };
