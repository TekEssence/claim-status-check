import { normalizeEligibilityLoginUrl } from "../../login-url";
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

export async function readMediCalInput(file: File): Promise<EligibilityInputRow[]> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The eligibility workbook does not contain a worksheet.");
  // Keep empty rows while parsing so the original Excel row numbers stay intact.
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false, blankrows: true });
  if (!rawRows.length || !Object.keys(rawRows[0]).some((key) => normalizeHeader(key) === "primaryinsurancename")) {
    throw new Error('MediCal input requires "Primary Insurance Name".');
  }
  return rawRows.flatMap((raw, index) => {
    if (!Object.values(raw).some((entry) => String(entry ?? "").trim())) return [];
    const project = value(raw, ["Project", "Project Name", "Project ID"]);
    if (project && !credentialProjectMatches("medrevenue", project)) return [];
    const payer = value(raw, ["Primary Insurance Name", "Payer", "Insurance Name"]);
    if (!["medical", "medicare", "molina", "molinahealthcare", "medicaremolina"].includes(normalizeHeader(payer))) return [];
    const name = splitPatientName(value(raw, ["Patient Name", "Subscriber Name", "Member Name"]));
    const memberId = value(raw, ["Member ID", "Subscriber ID", "BIC", "CIN", "Primary Insurance ID#", "Primary Insurance ID", "Primary Ins Subscriber No"]);
    return [{ originalIndex: index + 2, raw, memberId, subscriberId: memberId,
      patientFirstName: value(raw, ["Subscriber First Name", "Patient First Name", "First Name"]) || name.firstName,
      patientLastName: value(raw, ["Subscriber Last Name", "Patient Last Name", "Last Name"]) || name.lastName,
      dateOfBirth: value(raw, ["Date of Birth", "DOB", "Subscriber Birth Date", "Patient DOB", "Subscriber DOB"]),
      dateOfService: value(raw, ["DOS", "Service Date", "Date of Service (DOS)", "Date of Service", "Plan Date", "Plan Date(s)"]),
    }];
  });
}

export async function readMediCalCredentials(file: File) {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("MediCal credential workbook has no worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  const candidates = rows.filter((raw) => {
    const project = value(raw, ["Project", "Project Name"]);
    const portal = value(raw, ["Portal", "Portal Name"]);
    return (!project || credentialProjectMatches("medrevenue", project)) && (!portal || normalizeHeader(portal) === "medical");
  });
  if (candidates.length !== 1) throw new Error("Provide exactly one MedRevenu MediCal credential row.");
  const raw = candidates[0];
  const credentials = { username: value(raw, ["Email ID", "Email", "Email Address", "Username", "User Name"]), password: value(raw, ["Password"]), loginUrl: value(raw, ["Link", "URL", "Login URL", "Portal Link"]) };
  if (Object.values(credentials).some((entry) => !entry)) throw new Error("MediCal credentials require Email ID, Password, and Link (login URL).");
  credentials.loginUrl = normalizeEligibilityLoginUrl(credentials.loginUrl);
  return credentials;
}

export async function buildMediCalOutput(options: {
  inputFile: File; rows: Map<number, EligibilityInputRow>; results: Map<number, EligibilityResult>; errors: Map<number, string>;
}): Promise<Buffer> {
  const inputBytes = await options.inputFile.arrayBuffer();
  let inputFile = options.inputFile;
  if (/\.xls$/i.test(options.inputFile.name)) {
    const converted = new ExcelJS.Workbook();
    const source = XLSX.read(inputBytes, { type: "array" });
    for (const name of source.SheetNames) {
      converted.addWorksheet(name).addRows(XLSX.utils.sheet_to_json(source.Sheets[name], { header: 1, defval: "", raw: false, blankrows: true }));
    }
    inputFile = new File([new Uint8Array(await converted.xlsx.writeBuffer())], 'input.xlsx');
  }
  const commonOutput = await buildWaystarOutputWorkbook({ ...options, inputFile, projectId: "medrevenue" });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(new Uint8Array(commonOutput).buffer);
  const sheet = getMedRevenueOutputWorksheet(workbook);
  const columns: Record<string, number> = {};
  sheet.getRow(1).eachCell((cell, index) => { columns[normalizeHeader(cell.text)] = index; });
  for (const header of ["Description", "Medicare ID", "Subscriber Name", "error"]) {
    const key = normalizeHeader(header);
    if (!columns[key]) {
      columns[key] = sheet.columnCount + 1;
      sheet.getCell(1, columns[key]).value = header;
    }
    const cell = sheet.getCell(1, columns[key]);
    cell.style = structuredClone(sheet.getCell(1, columns[normalizeHeader("Coverage Status")]).style);
    sheet.getColumn(columns[key]).width = header === "Description" ? 60 : 25;
  }
  for (const [index] of options.rows) {
    for (const [header, entry] of Object.entries(medicalOutputValues(options.results.get(index), options.errors.get(index)))) {
      const cell = sheet.getCell(index, columns[normalizeHeader(header)]);
      cell.value = entry;
      cell.style = structuredClone(sheet.getCell(index, columns[normalizeHeader("Coverage Status")]).style);
    }
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function medicalOutputValues(result?: EligibilityResult, error?: string): Record<string, string> {
  return {
    "Description": error ? "" : result?.coverageDescription || "",
    "Medicare ID": error ? "" : String(result?.metadata?.medicareId || ""),
    "Subscriber Name": error ? "" : result?.patientName || "",
    "error": error || "",
  };
}
