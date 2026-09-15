import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import type { EligibilityInputRow, EligibilityResult } from "../../types";
import { credentialProjectMatches } from "../../projects";
import { splitPatientName } from "../waystar/input";
import { buildWaystarOutputWorkbook } from "../waystar/output";

const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
export function value(raw: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    const entry = Object.entries(raw).find(([key]) => normalizeHeader(key) === normalizeHeader(alias));
    if (entry && String(entry[1] ?? "").trim()) return String(entry[1]).trim();
  }
  return "";
}

export async function readIehpInput(file: File): Promise<EligibilityInputRow[]> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The eligibility workbook does not contain a worksheet.");
  // Keep empty rows while parsing so the original Excel row numbers stay intact.
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false, blankrows: true });
  if (!rawRows.length || !Object.keys(rawRows[0]).some((key) => normalizeHeader(key) === "primaryinsurancename")) {
    throw new Error('Iehp input requires "Primary Insurance Name".');
  }
  return rawRows.flatMap((raw, index) => {
    if (!Object.values(raw).some((entry) => String(entry ?? "").trim())) return [];
    const project = value(raw, ["Project", "Project Name", "Project ID"]);
    if (project && !credentialProjectMatches("medrevenue", project)) return [];
    const payer = value(raw, ["Primary Insurance Name", "Payer", "Insurance Name"]);
    if (payer && !["iehp", "inlandempirehealthplan"].includes(normalizeHeader(payer))) return [];
    const name = splitPatientName(value(raw, ["Patient Name", "Subscriber Name", "Member Name"]));
    const memberId = value(raw, ["IEHP ID", "SSN", "CIN", "Primary Insurance ID#", "Primary Insurance ID", "Primary Ins Subscriber No", "Subscriber ID", "Member ID"]);
    return [{ originalIndex: index + 2, raw, memberId, subscriberId: memberId,
      patientFirstName: value(raw, ["Subscriber First Name", "Patient First Name", "First Name"]) || name.firstName,
      patientLastName: value(raw, ["Subscriber Last Name", "Patient Last Name", "Last Name"]) || name.lastName,
      dateOfBirth: value(raw, ["DOB", "Date of Birth", "Patient DOB", "Subscriber DOB"]),
      dateOfService: value(raw, ["DOS", "Date of Service (DOS)", "Date of Service", "Plan Date", "Plan Date(s)"]),
    }];
  });
}

export async function readIehpCredentials(file: File) {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Iehp credential workbook has no worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  const candidates = rows.filter((raw) => {
    const project = value(raw, ["Project", "Project Name"]);
    const portal = value(raw, ["Portal", "Portal Name"]);
    return (!project || credentialProjectMatches("medrevenue", project)) && (!portal || normalizeHeader(portal) === "iehp");
  });
  if (candidates.length !== 1) throw new Error("Provide exactly one MedRevenu Iehp credential row.");
  const raw = candidates[0];
  const credentials = { username: value(raw, ["Username", "User Name", "User ID"]), password: value(raw, ["Password"]), loginUrl: value(raw, ["Link", "URL", "Login URL", "Portal Link"]) };
  if (Object.values(credentials).some((entry) => !entry)) throw new Error("Iehp credentials require Username, Password, and Link (login URL).");
  if (new URL(credentials.loginUrl).protocol !== "https:") throw new Error("Iehp login URL must use HTTPS.");
  return credentials;
}

export async function buildIehpOutput(options: {
  inputFile: File; rows: Map<number, EligibilityInputRow>; results: Map<number, EligibilityResult>; errors: Map<number, string>;
}): Promise<Buffer> {
  const existing = await buildWaystarOutputWorkbook({ ...options, projectId: "medrevenue" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(existing).buffer);
  const sheet = workbook.worksheets[0];
  const columns: Record<string, number> = {};
  sheet.getRow(1).eachCell((cell, index) => { columns[cell.text] = index; });
  for (const header of ["Plan", "OHC", "Medicare ID", "IPA", "Hospital", "error"]) {
    if (!columns[header]) {
      const index = sheet.columnCount + 1;
      columns[header] = index;
      sheet.getCell(1, index).value = header;
      sheet.getCell(1, index).style = { ...sheet.getCell(1, columns["Coverage Status"]).style };
      sheet.getColumn(index).width = 25;
    }
  }
  for (const [index] of options.rows) {
    const result = options.results.get(index);
    const error = options.errors.get(index);
    for (const [header, entry] of Object.entries(iehpOutputValues(result, error))) {
      if (columns[header]) sheet.getCell(index, columns[header]).value = entry || "-";
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function iehpOutputValues(result?: EligibilityResult, error?: string): Record<string, string> {
  return {
    "Coverage Status": error ? "error" : result?.coverageStatus === "active" ? "Active Coverage" : result?.coverageStatus === "inactive" ? "Inactive Coverage" : "unknown",
    "Eff Date": error ? "" : result?.effectiveDate || "",
    "Plan": error ? "" : result?.planName || "",
    "OHC": error ? "" : String(result?.metadata?.ohc || ""),
    "Medicare ID": error ? "" : String(result?.metadata?.medicareId || ""),
    "IPA": error ? "" : result?.ipa || "",
    "Hospital": error ? "" : String(result?.metadata?.hospital || ""),
    "error": error || "",
  };
}
