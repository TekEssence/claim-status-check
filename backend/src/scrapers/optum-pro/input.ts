import * as XLSX from "xlsx";
import { optumProConfig } from "./config";

export type OptumProCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

export type OptumProInput = {
  credentials: OptumProCredentials;
  inputFileName: string;
  rows: OptumProInputRow[];
};

export type OptumProInputRow = {
  raw: Record<string, unknown>;
  rowNumber: number;
  medicalGroupName: string;
  patient: string;
  dos: string;
  cpt: string;
  memberId: string;
};

function asText(value: unknown): string {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${month}/${day}/${value.getFullYear()}`;
  }
  return value == null ? "" : String(value).trim();
}

function normalizeUrl(value: string): string {
  if (!value) return optumProConfig.defaultLoginUrl;
  return value.startsWith("http") ? value : `https://${value}`;
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const wanted = aliases.map((alias) => alias.toLowerCase().replace(/[^a-z0-9]+/g, ""));
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (wanted.includes(normalizedKey)) {
      const text = asText(value);
      if (text) return text;
    }
  }
  return "";
}

const MEDICAL_GROUP_NAME_ALIASES = ["Medical Group Name"];
const PATIENT_ALIASES = ["Patient", "Patient Name", "Member Name"];
const DOS_ALIASES = ["DOS", "Date Of Service", "Date of Service", "Service Date", "First Service Date"];
const CPT_ALIASES = ["CPT", "CPT Code", "Procedure Code", "Proc Code"];
const MEMBER_ID_ALIASES = ["Member Id", "Member ID", "MemberId", "Subscriber ID", "Subscriber Id", "Policy ID", "Member Policy ID"];

export function readOptumProInputRowsFromBuffer(buffer: ArrayBuffer): OptumProInputRow[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error("Optum Pro claim Excel does not contain any sheets.");
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  const inputRows = rows
    .map((row, index) => ({
      raw: row,
      rowNumber: index + 2,
      medicalGroupName: findValue(row, MEDICAL_GROUP_NAME_ALIASES),
      patient: findValue(row, PATIENT_ALIASES),
      dos: findValue(row, DOS_ALIASES),
      cpt: findValue(row, CPT_ALIASES),
      memberId: findValue(row, MEMBER_ID_ALIASES).replace(/\s+/g, ""),
    }))
    .filter((row) => row.medicalGroupName || row.patient || row.dos || row.cpt || row.memberId);

  const invalidRows = inputRows
    .map((row) => {
      const missing = [
        !row.medicalGroupName ? "Medical Group Name" : "",
        !row.patient ? "Patient" : "",
        !row.dos ? "DOS" : "",
        !row.cpt ? "CPT" : "",
      ].filter(Boolean);
      return missing.length ? `row ${row.rowNumber}: ${missing.join(", ")}` : "";
    })
    .filter(Boolean);

  if (invalidRows.length) {
    throw new Error(`Optum Pro claim Excel is missing mandatory values (${invalidRows.join("; ")}).`);
  }

  if (!inputRows.length) {
    throw new Error("Optum Pro claim Excel contains no rows to process.");
  }

  return inputRows;
}

export function readOptumProCredentialsFromBuffer(buffer: ArrayBuffer): OptumProCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
  for (const row of rows) {
    const username = findValue(row, [
      "One Healthcare ID or Email Address",
      "One Healthcare ID",
      "Healthcare ID",
      "Email Address",
      "Username",
      "User Name",
      "Login ID",
    ]);
    const password = findValue(row, ["Password", "Pwd"]);
    const loginUrl = normalizeUrl(findValue(row, ["Login URL", "URL", "Optum URL", "PORTAL_OPTUM_PRO_LOGIN_URL"]));

    if (username && password) {
      return { loginUrl, username, password };
    }
  }

  return null;
}

function credentialsFromEnv(): OptumProCredentials | null {
  const username = asText(process.env.PORTAL_OPTUM_PRO_USERNAME ?? process.env.OPTUM_PRO_USERNAME);
  const password = asText(process.env.PORTAL_OPTUM_PRO_PASSWORD ?? process.env.OPTUM_PRO_PASSWORD);
  if (!username || !password) return null;

  return {
    loginUrl: normalizeUrl(asText(process.env.PORTAL_OPTUM_PRO_LOGIN_URL ?? process.env.OPTUM_PRO_LOGIN_URL)),
    username,
    password,
  };
}

export async function parseOptumProInput(formData: FormData): Promise<OptumProInput> {
  const inputExcel = formData.get("inputExcel");
  if (!(inputExcel instanceof File)) {
    throw new Error("Missing Optum Pro claim Excel file. Required columns: Medical Group Name, Patient, DOS, CPT, Member Id.");
  }

  const rows = readOptumProInputRowsFromBuffer(await inputExcel.arrayBuffer());

  const loginExcel = formData.get("loginExcel");
  if (loginExcel instanceof File) {
    const credentials = readOptumProCredentialsFromBuffer(await loginExcel.arrayBuffer());
    if (credentials) {
      return { credentials, inputFileName: inputExcel.name || "optum_pro_claims.xlsx", rows };
    }
  }

  const envCredentials = credentialsFromEnv();
  if (envCredentials) {
    return { credentials: envCredentials, inputFileName: inputExcel.name || "optum_pro_claims.xlsx", rows };
  }

  throw new Error("Missing Optum Pro credentials. Upload a login Excel with One Healthcare ID or Email Address and Password columns.");
}
