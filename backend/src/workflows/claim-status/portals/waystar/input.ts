import * as XLSX from "xlsx";
import { readWaystarCredentials } from "../../../eligibility-verification/portals/waystar/credentials";
import type { WaystarClaimInputRow, WaystarInvalidInputRow, WaystarParsedInput } from "./types";

const PATIENT_NAME_ALIASES = ["Patient Name", "Patient", "Member Name", "Patient Full Name"];
const RESPONSIBLE_PAYER_ALIASES = ["Responsible Payer", "Payer", "Insurance", "Insurance Name"];
const CLAIM_NUMBER_ALIASES = ["Claim Number", "Claim No", "Claim #", "ICN"];
const DOS_ALIASES = ["DOS", "Date Of Service", "Service Date", "Date of Service"];

function asText(value: unknown): string {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${month}/${day}/${value.getFullYear()}`;
  }
  return value == null ? "" : String(value).trim();
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) {
    if (!normalizedAliases.has(normalizeHeader(key))) continue;
    const text = asText(value);
    if (text) return text;
  }
  return "";
}

function normalizeDos(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";

  const slash = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (slash) {
    const month = slash[1].padStart(2, "0");
    const day = slash[2].padStart(2, "0");
    const year = slash[3].length === 2 ? `20${slash[3]}` : slash[3];
    return `${month}/${day}/${year}`;
  }

  const iso = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[2]}/${iso[3]}/${iso[1]}`;
  }

  return trimmed;
}

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

export async function parseWaystarClaimWorkbook(file: File): Promise<{
  inputHeaders: string[];
  claimRows: WaystarClaimInputRow[];
  invalidRows: WaystarInvalidInputRow[];
  totalRows: number;
}> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error("The Waystar claim workbook does not contain a worksheet.");
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  const inputHeaders = rows[0] ? Object.keys(rows[0]) : [];
  const claimRows: WaystarClaimInputRow[] = [];
  const invalidRows: WaystarInvalidInputRow[] = [];

  rows.forEach((row, index) => {
    const patientName = findValue(row, PATIENT_NAME_ALIASES);
    const claimNumber = findValue(row, CLAIM_NUMBER_ALIASES);
    const responsiblePayer = findValue(row, RESPONSIBLE_PAYER_ALIASES);
    const dos = normalizeDos(findValue(row, DOS_ALIASES));
    const missingFields = [
      !patientName ? "Patient Name" : "",
      !responsiblePayer ? "Responsible Payer" : "",
      !dos ? "DOS" : "",
    ].filter(Boolean);

    const base = {
      inputRowId: index + 1,
      originalIndex: index + 2,
      patientName,
      claimNumber,
      responsiblePayer,
      dos,
      raw: row,
    };

    if (missingFields.length > 0) {
      invalidRows.push({
        ...base,
        missingFields,
        error: `Missing required fields: ${missingFields.join(", ")}.`,
      });
      return;
    }

    claimRows.push(base);
  });

  return {
    inputHeaders,
    claimRows,
    invalidRows,
    totalRows: rows.length,
  };
}

export async function parseWaystarInput(formData: FormData): Promise<WaystarParsedInput> {
  const loginExcel = requireFile(formData, "loginExcel", "Waystar login workbook");
  const inputExcel = requireFile(formData, "inputExcel", "Waystar claim workbook");
  const credentials = await readWaystarCredentials(loginExcel);
  const parsedWorkbook = await parseWaystarClaimWorkbook(inputExcel);

  return {
    credentials,
    claimRows: parsedWorkbook.claimRows,
    invalidRows: parsedWorkbook.invalidRows,
    inputHeaders: parsedWorkbook.inputHeaders,
    totalRows: parsedWorkbook.totalRows,
    claimFileName: inputExcel.name || "waystar_claims.xlsx",
    loginFileName: loginExcel.name || "waystar_login.xlsx",
  };
}
