import * as XLSX from "xlsx";
import { myFamilyConfig } from "./config";

export type MyFamilyCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

export type MyFamilyInputRow = Record<string, unknown> & {
  inputRowId: number;
  memberId: string;
  patientFirstName: string;
  patientLastName: string;
  dos: string;
  cptCode: string;
  providerClaimId: string;
  validationStatus: "valid" | "invalid";
  validationMessage: string;
};

export type MyFamilyInput = {
  credentials: MyFamilyCredentials;
  inputWorkbookBuffer: ArrayBuffer;
  inputFileName: string;
};

const MEMBER_ID_ALIASES = ["Member ID", "MemberID", "Member Id", "Member Number", "Subscriber ID", "Policy ID"];
const DOS_ALIASES = ["DOS", "Date Of Service", "Date of Service", "Service Date", "Svc Date", "From DOS", "DOS From"];
const CPT_ALIASES = ["CPT", "CPT Code", "Procedure Code", "Proc Code", "Service Code", "HCPCS", "HCPCS Code"];
const FIRST_NAME_ALIASES = ["Patient First Name", "First Name", "Member First Name", "PatientFirstName"];
const LAST_NAME_ALIASES = ["Patient Last Name", "Last Name", "Member Last Name", "PatientLastName"];
// Used as a fallback when the workbook only has one combined name column instead of
// separate first/last name columns, e.g. a "Patient Name" column containing
// "Alaniz Acosta, Miguel" (Last Name, First Name).
const PATIENT_NAME_ALIASES = ["Patient Name", "Member Name", "PatientName", "MemberName", "Full Name", "Name", "Patient"];
const PROVIDER_CLAIM_ALIASES = ["Provider Claim ID", "Provider Claim", "Provider Claim#", "Prov Claim", "Claim ID"];

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
  const match = normalizeDate(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return false;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/**
 * Splits a combined "Last Name, First Name" (or, lacking a comma, "First Last") value
 * into its parts, e.g. "Alaniz Acosta, Miguel" -> { lastName: "Alaniz Acosta",
 * firstName: "Miguel" }. This is how the source workbook's single "Patient Name" column
 * is formatted when there are no separate first/last name columns.
 */
export function splitPatientName(fullName: string): { firstName: string; lastName: string } {
  const cleaned = fullName.replace(/\s+/g, " ").trim();
  if (!cleaned) return { firstName: "", lastName: "" };

  const commaIndex = cleaned.indexOf(",");
  if (commaIndex === -1) {
    const parts = cleaned.split(" ").filter(Boolean);
    if (parts.length < 2) return { firstName: cleaned, lastName: "" };
    return { firstName: parts[parts.length - 1], lastName: parts.slice(0, -1).join(" ") };
  }

  const lastName = cleaned.slice(0, commaIndex).trim();
  const firstName = cleaned.slice(commaIndex + 1).trim();
  return { firstName, lastName };
}

/**
 * Resolves patient first/last name from the row, preferring explicit
 * first-name/last-name columns and falling back to splitting a combined
 * "Patient Name"-style column when either part is missing.
 */
function resolvePatientNameFromRow(row: Record<string, unknown>): { firstName: string; lastName: string } {
  let firstName = findValue(row, FIRST_NAME_ALIASES);
  let lastName = findValue(row, LAST_NAME_ALIASES);

  if (!firstName || !lastName) {
    const combinedName = findValue(row, PATIENT_NAME_ALIASES);
    if (combinedName) {
      const split = splitPatientName(combinedName);
      firstName = firstName || split.firstName;
      lastName = lastName || split.lastName;
    }
  }

  return { firstName, lastName };
}

function loadCredentialsFromWorkbook(buffer: ArrayBuffer): MyFamilyCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  for (const row of rows) {
    const loginUrl = normalizeUrl(findValue(row, ["URL", "Url", "Login URL", "Website"])) || myFamilyConfig.defaultLoginUrl;
    const username = findValue(row, ["User ID", "Userid", "Username", "User Name"]);
    const password = findValue(row, ["Password", "Pass"]);
    if (loginUrl && username && password) return { loginUrl, username, password };
  }
  return null;
}

async function loadWorkbookBuffer(file: FormDataEntryValue | null, label: string): Promise<{ buffer: ArrayBuffer; fileName: string }> {
  if (!(file instanceof File)) throw new Error(`Missing My family ${label} Excel file.`);
  return { buffer: await file.arrayBuffer(), fileName: file.name || `my_family_${label}.xlsx` };
}

export async function parseMyFamilyInput(formData: FormData): Promise<MyFamilyInput> {
  const credentialWorkbook = await loadWorkbookBuffer(formData.get("credentialExcel"), "login");
  const inputWorkbook = await loadWorkbookBuffer(formData.get("inputExcel"), "claim");
  const credentials = loadCredentialsFromWorkbook(credentialWorkbook.buffer);
  if (!credentials) throw new Error("Missing My family credentials. Login workbook must include URL, User ID, and Password columns.");
  return { credentials, inputWorkbookBuffer: inputWorkbook.buffer, inputFileName: inputWorkbook.fileName };
}

export function readMyFamilyInputWorkbook(buffer: ArrayBuffer): MyFamilyInputRow[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("My family input workbook does not contain any sheets.");

  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  return rows
    .map((row, index) => {
      const memberId = findValue(row, MEMBER_ID_ALIASES).replace(/\s+/g, "");
      const { firstName: patientFirstName, lastName: patientLastName } = resolvePatientNameFromRow(row);
      const dos = normalizeDate(findValue(row, DOS_ALIASES));
      const cptCode = normalizeCptCode(findValue(row, CPT_ALIASES));
      const providerClaimId = findValue(row, PROVIDER_CLAIM_ALIASES);
      const missing = [
        !dos ? "DOS" : "",
        !memberId && (!patientFirstName || !patientLastName) ? "Member ID or Patient First/Last Name" : "",
      ].filter(Boolean);
      const validationMessage = missing.length ? `Missing ${missing.join(" and ")}.` : !isValidDate(dos) ? "Invalid DOS" : "";
      return {
        ...row,
        inputRowId: index + 2,
        memberId,
        patientFirstName,
        patientLastName,
        dos,
        cptCode,
        providerClaimId,
        validationStatus: validationMessage ? "invalid" : "valid",
        validationMessage,
      } satisfies MyFamilyInputRow;
    })
    .filter((row) => row.memberId || row.patientFirstName || row.patientLastName || row.dos || row.cptCode);
}