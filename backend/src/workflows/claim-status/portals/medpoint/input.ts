import * as XLSX from "xlsx";
import { medpointConfig } from "./config";
import type { MedpointCredentials, MedpointInputRow, MedpointParsedInput } from "./types";

function asText(value: unknown): string {
  if (value instanceof Date) {
    const month = `${value.getMonth() + 1}`.padStart(2, "0");
    const day = `${value.getDate()}`.padStart(2, "0");
    return `${month}/${day}/${value.getFullYear()}`;
  }
  return value == null ? "" : String(value).trim();
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeUrl(value: string): string {
  if (!value) return medpointConfig.defaultLoginUrl;
  return value.startsWith("http") ? value : `https://${value}`;
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const wanted = aliases.map(normalizeKey);
  for (const [key, value] of Object.entries(row)) {
    if (wanted.includes(normalizeKey(key))) return asText(value);
  }
  return "";
}

function splitPatientName(value: string): { memberLastName: string; memberFirstName: string } {
  const text = value.trim().replace(/\s+/g, " ");
  if (!text) return { memberLastName: "", memberFirstName: "" };

  if (text.includes(",")) {
    const [lastName, ...rest] = text.split(",");
    return {
      memberLastName: lastName.trim(),
      memberFirstName: rest.join(" ").trim(),
    };
  }

  const parts = text.split(" ").filter(Boolean);
  return {
    memberLastName: parts[0] || "",
    memberFirstName: parts.slice(1).join(" ").trim(),
  };
}

function normalizeDate(value: string): string {
  const text = value.trim();
  if (!text) return "";
  const parts = text.split(/[/-]/).map((item) => item.trim()).filter(Boolean);
  if (parts.length == 3) {
    let [a, b, c] = parts;
    if (c.length === 2) c = `${Number(c) >= 50 ? "19" : "20"}${c}`;
    const month = a.padStart(2, "0");
    const day = b.padStart(2, "0");
    if (c.length === 4) return `${month}/${day}/${c}`;
  }
  return text;
}

export function readMedpointCredentialsFromBuffer(buffer: ArrayBuffer): MedpointCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  for (const row of rows) {
    const username = findValue(row, ["Username", "User Name", "Login ID", "Email Address"]);
    const password = findValue(row, ["Password", "Pwd"]);
    const loginUrl = normalizeUrl(findValue(row, ["Login URL", "URL", "Portal URL", "Medpoint URL"]));
    if (username && password) return { loginUrl, username, password };
  }
  return null;
}

export function readMedpointInputRowsFromBuffer(buffer: ArrayBuffer): MedpointInputRow[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Medpoint claim Excel does not contain any sheets.");
  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  const parsed = rows.map((row, index) => {
    const patientName = findValue(row, ["Patient Name", "Member Name", "Patient", "Subscriber Name"]);
    const splitName = splitPatientName(patientName);
    const memberLastName = findValue(row, ["Member Last Name", "Last Name", "Patient Last Name"]) || splitName.memberLastName;
    const memberFirstName = findValue(row, ["Member First Name", "First Name", "Patient First Name"]) || splitName.memberFirstName;
    const serviceFromDate = normalizeDate(findValue(row, ["Service From Date", "From DOS", "DOS", "Date Of Service", "Service Date"]));
    const serviceToDate = normalizeDate(findValue(row, ["Service To Date", "To DOS", "DOS End", "Date Of Service To", "Service Date"])) || serviceFromDate;
    return {
      inputRowNumber: index + 2,
      memberLastName,
      memberFirstName,
      serviceFromDate,
      serviceToDate,
      claimNumber: findValue(row, ["Claim Number", "Claim #", "Claim No"]),
      patientAccount: findValue(row, ["Patient Account", "Patient Account #", "Account", "Account Number"]),
    };
  }).filter((row) => row.memberLastName || row.memberFirstName || row.serviceFromDate || row.claimNumber || row.patientAccount);

  const invalid = parsed.filter((row) => !row.memberLastName || !row.memberFirstName || !row.serviceFromDate || !row.serviceToDate);
  if (invalid.length > 0) {
    const sample = invalid[0];
    throw new Error(`Medpoint input row ${sample.inputRowNumber} is missing Member Last Name, Member First Name, or service date values.`);
  }
  return parsed;
}

export async function parseMedpointInput(formData: FormData): Promise<MedpointParsedInput> {
  const claimExcel = formData.get("claimExcel") ?? formData.get("inputExcel");
  if (!(claimExcel instanceof File)) {
    throw new Error("Missing Medpoint claim Excel file.");
  }
  const loginExcel = formData.get("loginExcel");
  if (!(loginExcel instanceof File)) {
    throw new Error("Missing Medpoint login Excel file.");
  }
  const credentials = readMedpointCredentialsFromBuffer(await loginExcel.arrayBuffer());
  if (!credentials) {
    throw new Error("Missing Medpoint credentials. Upload a login Excel with Username and Password columns.");
  }
  const rows = readMedpointInputRowsFromBuffer(await claimExcel.arrayBuffer());
  return {
    credentials,
    inputFileName: claimExcel.name || "medpoint_claims.xlsx",
    rows,
  };
}
