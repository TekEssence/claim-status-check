import ExcelJS from "exceljs";
import type { PaymentEobCredentials, PaymentEobReferenceRow } from "../../types";

const DEFAULT_LOGIN_URL = "https://essentials.availity.com/static/public/onb/onboarding-ui-apps/availity-fr-ui/#/login";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function normalizeCheckNumber(value: unknown): string {
  return String(value ?? "")
    .trim()
    .replace(/\.0$/, "")
    .replace(/\s+/g, "");
}

function asText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return formatDate(value);
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  if (typeof value === "object" && "result" in value) {
    return asText((value as { result?: unknown }).result);
  }
  return String(value).trim();
}

function formatDate(date: Date): string {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
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
  if (!trimmed) return DEFAULT_LOGIN_URL;
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

function parseLookbackDays(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return 10;
  const parsed = Number.parseInt(trimmed.replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid Lookback Days value "${value}". Enter a positive number like 10.`);
  }
  return parsed;
}

function base32Encode(buffer: Buffer<ArrayBufferLike>): string {
  let bits = "";
  for (const byte of buffer) {
    bits += byte.toString(2).padStart(8, "0");
  }

  let encoded = "";
  for (let index = 0; index < bits.length; index += 5) {
    const chunk = bits.slice(index, index + 5).padEnd(5, "0");
    encoded += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }
  return encoded;
}

function readVarint(buffer: Buffer, offset: number): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let cursor = offset;

  while (cursor < buffer.length) {
    const byte = buffer[cursor];
    value |= (byte & 0x7f) << shift;
    cursor += 1;
    if ((byte & 0x80) === 0) {
      return { value, offset: cursor };
    }
    shift += 7;
  }

  throw new Error("Invalid Google Authenticator migration data: truncated varint.");
}

function readLengthDelimited(buffer: Buffer<ArrayBufferLike>, offset: number): { value: Buffer<ArrayBufferLike>; offset: number } {
  const length = readVarint(buffer, offset);
  const end = length.offset + length.value;
  if (end > buffer.length) {
    throw new Error("Invalid Google Authenticator migration data: truncated field.");
  }
  return { value: buffer.subarray(length.offset, end), offset: end };
}

function decodeOtpParameter(message: Buffer<ArrayBufferLike>): { secret: Buffer<ArrayBufferLike>; type: number } {
  let offset = 0;
  let secret = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
  let type = 0;

  while (offset < message.length) {
    const tag = readVarint(message, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x07;

    if (fieldNumber === 1 && wireType === 2) {
      const field = readLengthDelimited(message, offset);
      secret = field.value;
      offset = field.offset;
    } else if (fieldNumber === 6 && wireType === 0) {
      const field = readVarint(message, offset);
      type = field.value;
      offset = field.offset;
    } else if (wireType === 0) {
      offset = readVarint(message, offset).offset;
    } else if (wireType === 2) {
      offset = readLengthDelimited(message, offset).offset;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      throw new Error(`Unsupported Google Authenticator migration field wire type ${wireType}.`);
    }
  }

  return { secret, type };
}

function extractMigrationDataValue(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/[?&]data=([^&]+)/);
  return match ? match[1] : trimmed;
}

function decodeGoogleAuthenticatorMigrationSecret(value: string): string {
  const migrationData = extractMigrationDataValue(value);
  const decoded = decodeURIComponent(migrationData).replace(/\s+/g, "");
  const padded = `${decoded}${"=".repeat((4 - (decoded.length % 4)) % 4)}`;
  const payload = Buffer.from(padded, "base64");
  let offset = 0;

  while (offset < payload.length) {
    const tag = readVarint(payload, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 0x07;

    if (fieldNumber === 1 && wireType === 2) {
      const field = readLengthDelimited(payload, offset);
      const account = decodeOtpParameter(field.value);
      offset = field.offset;
      if (account.secret.length && account.type === 2) {
        return base32Encode(account.secret);
      }
    } else if (wireType === 0) {
      offset = readVarint(payload, offset).offset;
    } else if (wireType === 2) {
      offset = readLengthDelimited(payload, offset).offset;
    } else if (wireType === 5) {
      offset += 4;
    } else if (wireType === 1) {
      offset += 8;
    } else {
      throw new Error(`Unsupported Google Authenticator migration payload wire type ${wireType}.`);
    }
  }

  throw new Error("Google Authenticator migration data does not contain a TOTP account.");
}

export function normalizeTotpSecret(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^otpauth-migration:\/\//i.test(trimmed) || /[?&]data=/i.test(trimmed)) {
    return decodeGoogleAuthenticatorMigrationSecret(trimmed);
  }
  const compact = trimmed.replace(/\s+/g, "");
  if (/^[A-Z2-7]+=*$/i.test(compact)) {
    return compact.replace(/=+$/g, "");
  }
  return decodeGoogleAuthenticatorMigrationSecret(compact);
}

async function readWorkbookRows(file: File, sheetName?: string): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const worksheet = sheetName
    ? workbook.worksheets.find((candidate) => normalizeAlias(candidate.name) === normalizeAlias(sheetName))
    : workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(sheetName
      ? `${file.name || "Workbook"} must contain a "${sheetName}" worksheet.`
      : `${file.name || "Workbook"} does not contain any worksheets.`);
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
      if (!header) return;
      data[header] = asText(row.getCell(colNumber).value);
    });
    if (Object.values(data).some(Boolean)) rows.push(data);
  });
  return rows;
}

export async function readAvailityRemittanceCredentials(file: File): Promise<PaymentEobCredentials> {
  const rows = await readWorkbookRows(file);
  for (const row of rows) {
    const username = findValue(row, ["Username", "User Name", "User ID", "USERNAME_AVA1"]);
    const password = findValue(row, ["Password", "PASSWORD_AVA1"]);
    const totpSecret = normalizeTotpSecret(findValue(row, [
      "Secret Key",
      "Secret",
      "TOTP Secret",
      "TOTP_SECRET",
      "Google Authenticator Data",
      "Authenticator Migration Data",
      "Migration Data",
    ]));
    if (!username || !password || !totpSecret) continue;

    return {
      loginUrl: normalizeLoginUrl(findValue(row, ["Link", "URL", "Login URL", "Portal Link", "LOGIN_URL_AVA"])),
      username,
      password,
      totpSecret,
      sharePoint: {
        tenantId: findValue(row, ["Tenant ID", "Microsoft Tenant ID", "Azure Tenant ID", "SharePoint Tenant ID"]),
        clientId: findValue(row, ["Client ID", "Microsoft Client ID", "Azure Client ID", "SharePoint Client ID"]),
        clientSecret: findValue(row, ["Client Secret", "Microsoft Client Secret", "Azure Client Secret", "SharePoint Client Secret"]),
        siteUrl: findValue(row, ["SharePoint Site URL", "Site URL", "SharePoint URL"]),
        folderPath: findValue(row, ["SharePoint Folder", "SharePoint Folder Path", "SharePoint Path", "Output Folder"]),
      },
      organization: findValue(row, ["Organization", "Org", "Provider Organization", "Practice", "Payee"]),
      startDate: findValue(row, ["Start Date", "Check Start Date", "From Date"]),
      endDate: findValue(row, ["End Date", "Check End Date", "To Date"]),
      lookbackDays: parseLookbackDays(findValue(row, ["Lookback Days", "Last N Days", "Days Back", "Date Range Days", "Last Days"])),
    };
  }

  throw new Error("Missing Availity Remittance credentials. Credential Excel must contain Username, Password, and Secret Key.");
}

export async function readReferenceRows(file: File): Promise<PaymentEobReferenceRow[]> {
  const rows = await readWorkbookRows(file, "tracker");
  const referenceRows = rows
    .map((row, index) => {
      const checkNumber = normalizeCheckNumber(findValue(row, [
        "Check/EFT Number",
        "Check/EFT #",
        "Check EFT Number",
        "Check Number",
        "EFT Number",
        "FD Number",
        "FD/Check/EFT Number",
        "FD",
      ]));
      return {
        rowNumber: index + 2,
        checkNumber,
        checkDate: findValue(row, ["Check / EFT Date", "Check/EFT Date", "Check Date", "EFT Date", "Payment Date", "Date"]),
        raw: row,
      };
    })
    .filter((row) => row.checkNumber);

  if (!referenceRows.length) {
    throw new Error("Reference Excel must contain at least one FD, Check, or EFT number.");
  }

  return referenceRows;
}
