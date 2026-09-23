import * as XLSX from "xlsx";
import ExcelJS from "exceljs";
import type { EligibilityInputRow, EligibilityResult } from "../../types";
import { credentialProjectMatches } from "../../projects";
import { splitPatientName } from "../waystar/input";
import { buildWaystarOutputWorkbook, getMedRevenueOutputWorksheet } from "../waystar/output";

const normalizeHeader = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
export function value(raw: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    const entry = Object.entries(raw).find(([key]) => normalizeHeader(key) === normalizeHeader(alias));
    if (entry && String(entry[1] ?? "").trim()) return String(entry[1]).trim();
  }
  return "";
}

export async function readTriZettoInput(file: File): Promise<EligibilityInputRow[]> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The eligibility workbook does not contain a worksheet.");
  // Keep empty rows while parsing so the original Excel row numbers stay intact.
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false, blankrows: true });
  if (!rawRows.length || !Object.keys(rawRows[0]).some((key) => normalizeHeader(key) === "primaryinsurancename")) {
    throw new Error('TriZetto input requires "Primary Insurance Name".');
  }
  return rawRows.flatMap((raw, index) => {
    if (!Object.values(raw).some((entry) => String(entry ?? "").trim())) return [];
    const project = value(raw, ["Project", "Project Name", "Project ID"]);
    if (project && !credentialProjectMatches("medrevenue", project)) return [];
    const name = splitPatientName(value(raw, ["Patient Name", "Subscriber Name", "Member Name"]));
    const memberId = value(raw, ["Primary Insurance ID#", "Primary Insurance ID", "Primary Ins Subscriber No", "Subscriber ID", "Member ID"]);
    return [{ originalIndex: index + 2, raw, memberId, subscriberId: memberId,
      patientFirstName: value(raw, ["Subscriber First Name", "Patient First Name", "First Name"]) || name.firstName,
      patientLastName: value(raw, ["Subscriber Last Name", "Patient Last Name", "Last Name"]) || name.lastName,
      dateOfBirth: value(raw, ["DOB", "Date of Birth", "Patient DOB", "Subscriber DOB"]),
      dateOfService: value(raw, ["DOS", "Date of Service (DOS)", "Date of Service", "Plan Date", "Plan Date(s)"]),
    }];
  });
}

export async function readTriZettoCredentials(file: File) {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("TriZetto credential workbook has no worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  const candidates = rows.filter((raw) => {
    const project = value(raw, ["Project", "Project Name"]);
    const portal = value(raw, ["Portal", "Portal Name"]);
    return (!project || credentialProjectMatches("medrevenue", project)) && (!portal || normalizeHeader(portal) === "trizetto");
  });
  if (candidates.length !== 1) throw new Error("Provide exactly one MedRevenu TriZetto credential row.");
  const raw = candidates[0];
  const credentials = { username: value(raw, ["Username", "User Name", "User ID"]), password: value(raw, ["Password"]), loginUrl: value(raw, ["Link", "URL", "Login URL", "Portal Link"]) };
  if (Object.values(credentials).some((entry) => !entry)) throw new Error("TriZetto credentials require Username, Password, and Link (login URL).");
  if (new URL(credentials.loginUrl).protocol !== "https:") throw new Error("TriZetto login URL must use HTTPS.");
  return credentials;
}

export type Payer = { name: string; id: string; index: number };
const normalizePayer = (name: string) => name.trim().replace(/\s+/g, " ").toLowerCase();
export function matchTriZettoPayer(name: string, payers: Payer[]): Payer {
  if (!name.trim()) throw new Error("Primary Insurance Name is missing.");
  // Preserve punctuation, state and plan qualifiers. No fuzzy/substring routing.
  const matches = payers.filter((payer) => normalizePayer(payer.name) === normalizePayer(name));
  if (!matches.length) throw new Error(`TriZetto payer not found: ${name}.`);
  const ids = new Set(matches.map((payer) => payer.id));
  if (ids.size !== 1 || !matches[0].id) throw new Error(`Ambiguous TriZetto payer: ${name}.`);
  return matches[0]; // Favorites and category copies with the same payer ID are equivalent.
}

export async function buildTriZettoOutput(options: {
  inputFile: File; rows: Map<number, EligibilityInputRow>; results: Map<number, EligibilityResult>; errors: Map<number, string>;
}): Promise<Buffer> {
  const existing = await buildWaystarOutputWorkbook({ ...options, projectId: "medrevenue" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(existing).buffer);
  const sheet = getMedRevenueOutputWorksheet(workbook);
  let column = 0;
  let patientNameColumn = 0;
  sheet.getRow(1).eachCell((cell, index) => { if (normalizeHeader(cell.text) === "patientname") patientNameColumn = index; });
  sheet.getRow(1).eachCell((cell, index) => { if (cell.text === "Description") column = index; });
  column ||= sheet.columnCount + 1;
  sheet.getCell(1, column).value = "Description";
  sheet.getCell(1, column).style = { ...sheet.getCell(1, column - 1).style };
  sheet.getColumn(column).width = 60;
  for (const [index] of options.rows) {
    const result = options.results.get(index);
    if (patientNameColumn && result?.patientName && !options.errors.has(index)) {
      sheet.getCell(index, patientNameColumn).value = result.patientName;
    }
    sheet.getCell(index, column).value = options.errors.get(index) || String(options.results.get(index)?.metadata?.trizettoDescription ?? "") || "-";
    sheet.getCell(index, column).alignment = { vertical: "top", wrapText: true };
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
