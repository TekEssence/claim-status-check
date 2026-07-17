import * as XLSX from "xlsx";
import { cignaConfig } from "./config";

export type CignaCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

export type CignaInputRow = Record<string, unknown> & {
  inputRowId: number;
  memberId: string;
  patientFirstName: string;
  patientLastName: string;
  dateOfBirth: string;
  dos: string;
  cptCode: string;
  taxId: string;
  validationStatus: "valid" | "invalid";
  validationMessage: string;
};

export type CignaInput = {
  credentials: CignaCredentials;
  inputWorkbookBuffer: ArrayBuffer;
  inputFileName: string;
};

const MEMBER_ID_ALIASES = ["Member ID", "MemberID", "Cigna Patient ID", "Patient ID", "Subscriber ID", "Policy ID"];
const FIRST_NAME_ALIASES = ["First Name", "Patient First Name", "Member First Name", "Firstname"];
const LAST_NAME_ALIASES = ["Last Name", "Patient Last Name", "Member Last Name", "Lastname"];
const PATIENT_NAME_ALIASES = ["Patient Name", "Member Name", "Name", "Patient"];
const DOB_ALIASES = ["DOB", "Date of Birth", "Date Of Birth", "Birth Date"];
const DOS_ALIASES = ["DOS", "Date Of Service", "Date of Service", "Service Date", "Svc Date", "From DOS", "DOS From"];
const CPT_ALIASES = ["CPT", "CPT Code", "Procedure Code", "Proc Code", "Service Code", "HCPCS", "HCPCS Code"];
const TIN_ALIASES = ["TIN", "Tax ID", "Tax Identification Number", "Tax identification number (TIN)"];

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
  return `${month}/${day}/${year}`;
}

function isValidDate(value: string): boolean {
  if (!value) return false;
  const match = normalizeDate(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function splitPatientName(fullName: string): { firstName: string; lastName: string } {
  const cleaned = fullName.replace(/\s+/g, " ").trim();
  if (!cleaned) return { firstName: "", lastName: "" };
  const commaIndex = cleaned.indexOf(",");
  if (commaIndex >= 0) return { lastName: cleaned.slice(0, commaIndex).trim(), firstName: cleaned.slice(commaIndex + 1).trim() };
  const parts = cleaned.split(" ").filter(Boolean);
  if (parts.length < 2) return { firstName: cleaned, lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

function resolvePatientName(row: Record<string, unknown>): { firstName: string; lastName: string } {
  let firstName = findValue(row, FIRST_NAME_ALIASES);
  let lastName = findValue(row, LAST_NAME_ALIASES);
  if (!firstName || !lastName) {
    const combined = findValue(row, PATIENT_NAME_ALIASES);
    if (combined) {
      const split = splitPatientName(combined);
      firstName ||= split.firstName;
      lastName ||= split.lastName;
    }
  }
  return { firstName, lastName };
}

function loadCredentialsFromWorkbook(buffer: ArrayBuffer): CignaCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  for (const row of rows) {
    const loginUrl = normalizeUrl(findValue(row, ["URL", "Url", "Login URL", "Website", "Cigna URL"])) || cignaConfig.defaultLoginUrl;
    const username = findValue(row, ["User ID", "Userid", "Username", "User Name"]);
    const password = findValue(row, ["Password", "Pass"]);
    if (loginUrl && username && password) return { loginUrl, username, password };
  }
  return null;
}

async function loadWorkbookBuffer(file: FormDataEntryValue | null, label: string): Promise<{ buffer: ArrayBuffer; fileName: string }> {
  if (!(file instanceof File)) throw new Error(`Missing Cigna ${label} Excel file.`);
  return { buffer: await file.arrayBuffer(), fileName: file.name || `cigna_${label}.xlsx` };
}

export async function parseCignaInput(formData: FormData): Promise<CignaInput> {
  const credentialWorkbook = await loadWorkbookBuffer(formData.get("credentialExcel"), "login");
  const inputWorkbook = await loadWorkbookBuffer(formData.get("inputExcel"), "claim");
  const credentials = loadCredentialsFromWorkbook(credentialWorkbook.buffer);
  if (!credentials) throw new Error("Missing Cigna credentials. Login workbook must include URL, User ID, and Password columns.");
  return { credentials, inputWorkbookBuffer: inputWorkbook.buffer, inputFileName: inputWorkbook.fileName };
}

export function readCignaInputWorkbook(buffer: ArrayBuffer): CignaInputRow[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Cigna input workbook does not contain any sheets.");
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  return rows
    .map((row, index) => {
      const memberId = findValue(row, MEMBER_ID_ALIASES).replace(/\s+/g, "");
      const { firstName: patientFirstName, lastName: patientLastName } = resolvePatientName(row);
      const dateOfBirth = normalizeDate(findValue(row, DOB_ALIASES));
      const dos = normalizeDate(findValue(row, DOS_ALIASES));
      const cptCode = normalizeCptCode(findValue(row, CPT_ALIASES));
      const taxId = findValue(row, TIN_ALIASES).replace(/\D+/g, "");
      const missing = [
        !memberId ? "Member ID" : "",
        !patientFirstName ? "First name" : "",
        !patientLastName ? "Last name" : "",
        !cptCode ? "CPT" : "",
      ].filter(Boolean);
      const validationMessage = missing.length
        ? `Missing ${missing.join(", ")}.`
        : dos && !isValidDate(dos)
          ? "Invalid DOS"
          : "";
      return {
        ...row,
        inputRowId: index + 2,
        memberId,
        patientFirstName,
        patientLastName,
        dateOfBirth,
        dos,
        cptCode,
        taxId,
        validationStatus: validationMessage ? "invalid" : "valid",
        validationMessage,
      } satisfies CignaInputRow;
    })
    .filter((row) => row.memberId || row.patientFirstName || row.patientLastName || row.dos || row.cptCode);
}
