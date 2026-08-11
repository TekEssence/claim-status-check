import * as XLSX from "xlsx";
import { physiciansConfig } from "./config";

export type PhysiciansCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

export type PhysiciansInputRow = Record<string, unknown> & {
  inputRowId: number;
  memberId: string;
  dos: string;
  dosTo: string;
  cptCode: string;
  providerClaimId: string;
  authorizationNumber: string;
  validationStatus: "valid" | "invalid";
  validationMessage: string;
};

export type PhysiciansInput = {
  credentials: PhysiciansCredentials;
  inputWorkbookBuffer: ArrayBuffer;
  inputFileName: string;
};

const MEMBER_ID_ALIASES = ["Member ID", "MemberID", "Member Id", "Member Number", "Subscriber ID", "Policy ID"];
const DOS_FROM_ALIASES = ["DOS", "Date Of Service", "Date of Service", "Service Date", "Svc Date", "From DOS", "DOS From", "Date of Service From"];
const DOS_TO_ALIASES = ["DOS To", "To DOS", "Date of Service To", "Service Date To", "Through Date"];
const CPT_ALIASES = ["CPT", "CPT Code", "Procedure Code", "Proc Code", "Service Code", "HCPCS", "HCPCS Code"];
const PROVIDER_CLAIM_ALIASES = ["Provider Claim ID", "Provider Claim", "Provider Claim#", "Provider Claim/Patient Account #", "Patient Account #", "Claim ID"];
const AUTH_ALIASES = ["Authorization #", "Authorization", "Auth #", "Auth Number", "Authorization Number"];

function asText(value: unknown): string {
  if (value instanceof Date) return `${value.getMonth() + 1}/${value.getDate()}/${value.getFullYear()}`;
  return value == null ? "" : String(value).trim();
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const wanted = aliases.map(normalizeKey);
  for (const [key, value] of Object.entries(row)) {
    if (wanted.includes(normalizeKey(key))) return asText(value);
  }
  return "";
}

function normalizeUrl(value: string): string {
  if (!value) return "";
  return value.startsWith("http") ? value : `https://${value}`;
}

export function normalizeCptCode(value: string): string {
  return String(value ?? "").replace(/\s+/g, "").replace(/\.0$/i, "").trim().toUpperCase();
}

export function normalizeDate(value: string): string {
  const text = value.trim();
  const match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!match) return text;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}-${year}`;
}

function isValidDate(value: string): boolean {
  const match = normalizeDate(value).match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function loadCredentialsFromWorkbook(buffer: ArrayBuffer): PhysiciansCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  for (const row of rows) {
    const loginUrl = normalizeUrl(findValue(row, ["URL", "Url", "Login URL", "Website"])) || physiciansConfig.defaultLoginUrl;
    const username = findValue(row, ["User ID", "Userid", "Username", "User Name"]);
    const password = findValue(row, ["Password", "Pass"]);
    if (loginUrl && username && password) return { loginUrl, username, password };
  }
  return null;
}

async function loadWorkbookBuffer(file: FormDataEntryValue | null, label: string): Promise<{ buffer: ArrayBuffer; fileName: string }> {
  if (!(file instanceof File)) throw new Error(`Missing Physicians ${label} Excel file.`);
  return { buffer: await file.arrayBuffer(), fileName: file.name || `physicians_${label}.xlsx` };
}

export async function parsePhysiciansInput(formData: FormData): Promise<PhysiciansInput> {
  const credentialWorkbook = await loadWorkbookBuffer(formData.get("credentialExcel"), "login");
  const inputWorkbook = await loadWorkbookBuffer(formData.get("inputExcel"), "claim");
  const credentials = loadCredentialsFromWorkbook(credentialWorkbook.buffer);
  if (!credentials) throw new Error("Missing Physicians credentials. Login workbook must include URL, User ID, and Password columns.");
  return { credentials, inputWorkbookBuffer: inputWorkbook.buffer, inputFileName: inputWorkbook.fileName };
}

export function readPhysiciansInputWorkbook(buffer: ArrayBuffer): PhysiciansInputRow[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Physicians input workbook does not contain any sheets.");

  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  return rows
    .map((row, index) => {
      const memberId = findValue(row, MEMBER_ID_ALIASES).replace(/\s+/g, "");
      const dos = normalizeDate(findValue(row, DOS_FROM_ALIASES));
      const dosTo = normalizeDate(findValue(row, DOS_TO_ALIASES)) || dos;
      const cptCode = normalizeCptCode(findValue(row, CPT_ALIASES));
      const providerClaimId = findValue(row, PROVIDER_CLAIM_ALIASES);
      const authorizationNumber = findValue(row, AUTH_ALIASES);
      const missing = [!memberId ? "Member ID" : "", !dos ? "DOS" : ""].filter(Boolean);
      const validationMessage = missing.length ? `Missing ${missing.join(" and ")}.` : !isValidDate(dos) || !isValidDate(dosTo) ? "Invalid DOS" : "";
      return {
        ...row,
        inputRowId: index + 2,
        memberId,
        dos,
        dosTo,
        cptCode,
        providerClaimId,
        authorizationNumber,
        validationStatus: validationMessage ? "invalid" : "valid",
        validationMessage,
      } satisfies PhysiciansInputRow;
    })
    .filter((row) => row.memberId || row.dos || row.cptCode || row.providerClaimId || row.authorizationNumber);
}