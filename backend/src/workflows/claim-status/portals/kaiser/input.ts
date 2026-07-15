import * as XLSX from "xlsx";
import { kaiserConfig } from "./config";

export type KaiserCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

export type KaiserInputRow = Record<string, unknown> & {
  inputRowId: number;
  memberId: string;
  dos: string;
  cptCodeRaw: string;
  cptCode: string;
  patientName: string;
  validationStatus: "valid" | "invalid";
  validationMessage: string;
};

export type KaiserInput = {
  credentials: KaiserCredentials;
  inputWorkbookBuffer: ArrayBuffer;
  inputFileName: string;
};

const MEMBER_ID_ALIASES = [
  "Member ID",
  "MemberID",
  "Member Id",
  "Member Number",
  "Member No",
  "Member #",
  "Subscriber ID",
  "Subscriber No",
  "Policy ID",
  "Member Policy ID",
];

const DOS_ALIASES = [
  "DOS",
  "Date Of Service",
  "Date of Service",
  "Service Date",
  "Svc Date",
  "Svc Frm Dt",
  "From DOS",
  "DOS From",
];

const CPT_ALIASES = [
  "CPT",
  "CPT Code",
  "Procedure Code",
  "Procedure",
  "Proc Code",
  "Service Code",
  "HCPCS",
  "HCPCS Code",
];

const PATIENT_NAME_ALIASES = [
  "Patient Name",
  "Member Name",
  "Name",
  "Patient",
  "Member",
];

function asText(value: unknown): string {
  if (value instanceof Date) {
    return `${value.getMonth() + 1}/${value.getDate()}/${value.getFullYear()}`;
  }
  return value == null ? "" : String(value).trim();
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const wanted = aliases.map(normalizeKey);
  for (const [key, value] of Object.entries(row)) {
    if (wanted.includes(normalizeKey(key))) {
      const text = asText(value);
      if (text) return text;
    }
  }
  return "";
}

function normalizeUrl(value: string): string {
  if (!value) return "";
  return value.startsWith("http") ? value : `https://${value}`;
}

function normalizeMemberId(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function isValidDos(value: string): boolean {
  const match = value.trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

export function normalizeCptCode(value: string): string {
  return String(value ?? "")
    .replace(/[\u00a0\r\n]+/g, " ")
    .replace(/\s+/g, "")
    .trim()
    .replace(/\.0$/i, "")
    .toUpperCase();
}

export function extractCptFromServiceText(value: string): string {
  const cleaned = String(value ?? "")
    .replace(/[\u00a0\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const beforeSeparator = cleaned.match(/^([A-Za-z0-9]+)\s*-\s*/)?.[1];
  const firstToken = cleaned.match(/^([A-Za-z0-9]+)/)?.[1];
  return normalizeCptCode(beforeSeparator || firstToken || "");
}

function loadCredentialsFromWorkbook(buffer: ArrayBuffer): KaiserCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  for (const row of rows) {
    const loginUrl = normalizeUrl(findValue(row, ["URL", "Url", "Login URL", "Kaiser URL"])) || kaiserConfig.defaultLoginUrl;
    const username = findValue(row, ["User ID", "Userid", "Username", "User Name", "pf.username"]);
    const password = findValue(row, ["Password", "pf.pass"]);
    if (loginUrl && username && password) {
      return { loginUrl, username, password };
    }
  }

  return null;
}

async function loadWorkbookBuffer(file: FormDataEntryValue | null, label: string): Promise<{ buffer: ArrayBuffer; fileName: string }> {
  if (!(file instanceof File)) {
    throw new Error(`Missing Kaiser ${label} Excel file.`);
  }
  return {
    buffer: await file.arrayBuffer(),
    fileName: file.name || `kaiser_${label}.xlsx`,
  };
}

export async function parseKaiserInput(formData: FormData): Promise<KaiserInput> {
  const credentialWorkbook = await loadWorkbookBuffer(formData.get("credentialExcel"), "login");
  const inputWorkbook = await loadWorkbookBuffer(formData.get("inputExcel"), "claim");
  const credentials = loadCredentialsFromWorkbook(credentialWorkbook.buffer);
  if (!credentials) {
    throw new Error("Missing Kaiser credentials. Login workbook must include URL, User ID, and Password columns.");
  }

  return {
    credentials,
    inputWorkbookBuffer: inputWorkbook.buffer,
    inputFileName: inputWorkbook.fileName,
  };
}

export function readKaiserInputWorkbook(buffer: ArrayBuffer): KaiserInputRow[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Kaiser input workbook does not contain any sheets.");

  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  return rows
    .map((row, index) => {
      const memberId = normalizeMemberId(findValue(row, MEMBER_ID_ALIASES));
      const dos = findValue(row, DOS_ALIASES);
      const cptCodeRaw = findValue(row, CPT_ALIASES);
      const cptCode = normalizeCptCode(cptCodeRaw);
      const patientName = findValue(row, PATIENT_NAME_ALIASES);
      const missing = [
        !memberId ? "Member ID" : "",
        !dos ? "DOS" : "",
        !cptCode ? "CPT" : "",
      ].filter(Boolean);
      const validationMessage = missing.length
        ? `Missing ${missing.join(" and ")}.`
        : !isValidDos(dos)
          ? "Invalid DOS"
          : "";
      return {
        ...row,
        inputRowId: index + 2,
        memberId,
        dos,
        cptCodeRaw,
        cptCode,
        patientName,
        validationStatus: validationMessage ? "invalid" : "valid",
        validationMessage,
      } satisfies KaiserInputRow;
    })
    .filter((row) => row.memberId || row.dos || row.cptCode);
}
