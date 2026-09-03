import * as XLSX from "xlsx";

export const ELIGIBILITY_PROJECT_IDS = ["minimax", "medrevenue"] as const;
export type EligibilityProjectId = (typeof ELIGIBILITY_PROJECT_IDS)[number];

function normalize(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function parseEligibilityProjectId(value: unknown): EligibilityProjectId {
  const normalized = normalize(value);
  if (normalized === "minimax" || normalized === "tpm") return "minimax";
  if (normalized === "medrevenue" || normalized === "medrevenu") return "medrevenue";
  throw new Error('projectId is required and must be either "minimax" or "medrevenue".');
}

export function credentialProjectMatches(projectId: EligibilityProjectId, value: unknown): boolean {
  const normalized = normalize(value);
  return projectId === "minimax"
    ? normalized === "tpm" || normalized === "minimax"
    : normalized === "medrevenue" || normalized === "medrevenu";
}

/**
 * Keeps the legacy Minimax workbook behavior when no Project column exists.
 * New MedRevenue runs must be explicitly scoped in the workbook, preventing
 * an uploaded Minimax/group workbook from being processed accidentally.
 */
export async function scopeEligibilityInputFile(
  file: File,
  projectId: EligibilityProjectId,
): Promise<File> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = firstSheetName ? workbook.Sheets[firstSheetName] : undefined;
  if (!sheet) throw new Error("The eligibility input workbook does not contain a worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("The eligibility input workbook is empty.");
  const projectHeader = Object.keys(rows[0]).find((key) => ["project", "projectname", "projectid"].includes(normalize(key)));

  if (!projectHeader) {
    if (projectId === "minimax") return file;
    throw new Error("MedRevenue eligibility input must contain a Project column so its rows remain isolated from Minimax.");
  }

  const selectedRows = rows.filter((row) => credentialProjectMatches(projectId, row[projectHeader]));
  if (!selectedRows.length) {
    throw new Error(`The eligibility input workbook contains no rows for ${projectId === "minimax" ? "Minimax" : "MedRevenue"}.`);
  }
  if (selectedRows.length === rows.length) return file;

  workbook.Sheets[firstSheetName] = XLSX.utils.json_to_sheet(selectedRows, { header: Object.keys(rows[0]) });
  const output = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return new File([new Uint8Array(output)], `${projectId}-${file.name}`, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
