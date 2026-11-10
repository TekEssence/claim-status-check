import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";
import { parseUhcClaimRows } from "./workbook-output";
import type { UhcProviderMapping } from "./automation";

function text(value: unknown): string {
  if (value && typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  return String(value ?? "").trim();
}

export async function readUhcProviderMappings(bytes: Uint8Array): Promise<UhcProviderMapping[]> {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(Buffer.from(bytes) as unknown as Parameters<typeof book.xlsx.load>[0]);
  const sheet = book.worksheets[0];
  if (!sheet) throw new Error("UHC provider mapping workbook does not contain a worksheet.");
  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, index) => columns.set(text(cell.value).toLowerCase().replace(/[^a-z0-9]/g, ""), index));
  const find = (...names: string[]) => names.map(name => columns.get(name)).find(Boolean) ?? 0;
  const group = find("group", "groupname", "medicalgroup", "medicalgroupname");
  const corporate = find("corporatetaxidowner", "corporateowner");
  const care = find("careprovider", "provider", "providername");
  const tax = find("taxidnumber", "taxid", "tin");
  if (!group || !corporate || !care) throw new Error("UHC provider mapping workbook requires Group, Corporate Tax ID Owner, and Care Provider columns.");
  const mappings: UhcProviderMapping[] = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const mapping = {
      group: text(row.getCell(group).value), corporateTaxIdOwner: text(row.getCell(corporate).value),
      careProvider: text(row.getCell(care).value), taxIdNumber: tax ? text(row.getCell(tax).value) : "",
    };
    if (mapping.group && (mapping.corporateTaxIdOwner || mapping.careProvider || mapping.taxIdNumber)) mappings.push(mapping);
  });
  if (!mappings.length) throw new Error("UHC provider mapping workbook does not contain usable mapping rows.");
  return mappings;
}

/** Both manual and service runs prepare from the uploaded workbook in the worker. */
export async function prepareUhcRuntimeClaims(formData: FormData, clientType: string) {
  const file = formData.get("claimExcel");
  if (file instanceof File && file.size) {
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(await file.arrayBuffer());
    if (!book.worksheets[0]) throw new Error("UHC claim workbook does not contain a worksheet.");
    const rows = parseUhcClaimRows(book.worksheets[0], { requirePatientDob: clientType !== "medrevenu" });
    if (!rows.length) throw new Error("UHC claim workbook contains no rows to process.");
    return rows;
  }
  // Retain the existing JSON input for legacy callers without a workbook.
  const rows = JSON.parse(String(formData.get("claimRows") || "null"));
  if (!Array.isArray(rows) || !rows.length) throw new Error("UHC claim workbook or claimRows is required.");
  return rows;
}

export async function loadDefaultUhcProviderMappings(): Promise<UhcProviderMapping[]> {
  return readUhcProviderMappings(await fs.readFile(path.join(process.cwd(), "public/provider-mappings/uhc-provider-mappings.xlsx")));
}
