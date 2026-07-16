import path from "node:path";
import ExcelJS from "exceljs";
import type { AvailityInputRow, AvailityProviderMapping } from "./types";

function asText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return `${String(value.getMonth() + 1).padStart(2, "0")}/${String(value.getDate()).padStart(2, "0")}/${value.getFullYear()}`;
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value).trim();
}

function normalizeAlias(value: unknown): string {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeHeader(value: unknown): string {
  return asText(value).replace(/\s+/g, " ").trim();
}

function normalizeLookup(value: unknown): string {
  return String(value || "").replace(/[^a-z0-9]+/gi, "").toLowerCase();
}

function findDataValue(data: Record<string, string>, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalizeLookup));
  for (const [key, value] of Object.entries(data)) {
    if (wanted.has(normalizeLookup(key)) && value) {
      return String(value).trim();
    }
  }
  return "";
}

function findRowValue(row: AvailityInputRow, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalizeLookup));
  for (const [key, value] of Object.entries(row.data)) {
    if (wanted.has(normalizeLookup(key)) && value) {
      return String(value).trim();
    }
  }
  return "";
}

export function normalizeProjectId(value: unknown): string {
  const normalized = normalizeAlias(value || "minimax");
  if (!normalized || normalized === "minimax") return "minimax";
  if (normalized === "medrevenu" || normalized === "medrevenue") return "medrevenu";
  throw new Error(`Unsupported Availity project "${asText(value)}". Supported projects: Minimax, Medrevenu.`);
}

export function applyProjectColumnMapping(projectId: string, data: Record<string, string>): Record<string, string> {
  if (projectId !== "medrevenu") {
    return data;
  }

  return {
    ...data,
    "Payer Name": findDataValue(data, ["Responsible Payer"]) || data["Payer Name"] || "",
    "Service Date": findDataValue(data, ["DOS"]) || data["Service Date"] || "",
    Charges: findDataValue(data, ["Billed Amount"]) || data.Charges || "",
    Group: findDataValue(data, ["Group"]) || data.Group || "",
    "Subscriber No": findDataValue(data, ["Member ID"]) || data["Subscriber No"] || "",
  };
}

export async function readAvailityProviderMapping(): Promise<AvailityProviderMapping[]> {
  const mappingPath = path.join(
    process.cwd(),
    "backend",
    "src",
    "workflows",
    "claim-status",
    "portals",
    "availity",
    "config",
    "Provider_mapping_ava.xlsx",
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(mappingPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Availity provider mapping workbook does not contain any worksheets.");
  }

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cell.value);
  });

  const projectCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Project"));
  const groupCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Group"));
  const providerCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Provider Name"));
  const activeCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Active"));
  if (projectCol < 1 || groupCol < 1 || providerCol < 1) {
    throw new Error("Availity provider mapping must contain Project, Group, and Provider Name columns.");
  }

  const mappings: AvailityProviderMapping[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const project = normalizeProjectId(asText(row.getCell(projectCol).value));
    const group = asText(row.getCell(groupCol).value);
    const providerName = asText(row.getCell(providerCol).value);
    const activeText = activeCol >= 1 ? asText(row.getCell(activeCol).value) : "Yes";
    const active = !/^(no|false|inactive|0)$/i.test(activeText.trim());
    if (project && group && providerName) {
      mappings.push({ project, group, providerName, active });
    }
  });

  return mappings;
}

export function getProviderOrderForRow(projectId: string, row: AvailityInputRow, providerMappings: AvailityProviderMapping[]): string[] | undefined {
  if (projectId !== "medrevenu") {
    return undefined;
  }

  const group = findRowValue(row, ["Group", "Group Name", "Group Code", "Medical Group", "Medical Group Name"]);
  if (!group) {
    throw new Error("Medrevenu Availity rows require a Group column value to select the provider.");
  }

  const match = providerMappings.find((mapping) => {
    return mapping.active
      && mapping.project === "medrevenu"
      && normalizeLookup(mapping.group) === normalizeLookup(group);
  });

  if (!match) {
    throw new Error(`No Availity provider mapping found for Medrevenu group "${group}". Update Provider_mapping_ava.xlsx.`);
  }

  return [match.providerName];
}
