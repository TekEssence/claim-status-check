import path from "node:path";
import ExcelJS from "exceljs";
import type { AvailityInputRow, AvailityMfaConfig, AvailityProviderMapping } from "./types";
import projectOrganizationMapping from "./config/project-organization-mapping.json";
import projectMfaConfig from "./config/project-mfa-config.json";

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

function cleanCharmPatientName(value: string): string {
  return String(value || "")
    .replace(/\s*\[[^\]]*]\s*/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanCharmProviderName(value: string): string {
  return String(value || "")
    .replace(/\s*\[[^\]]*$/, "")
    .replace(/\s*\[[^\]]*]\s*/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
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

function parseMoney(value: unknown): number | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const isNegative = /^\(.*\)$/.test(raw);
  const numeric = Number(raw.replace(/[()$,\s]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return isNegative ? -numeric : numeric;
}

function formatMoney(value: number): string {
  return value.toFixed(2);
}

export function normalizeProjectId(value: unknown): string {
  const normalized = normalizeAlias(value || "minimax");
  if (!normalized || normalized === "minimax") return "minimax";
  if (normalized === "medrevenu" || normalized === "medrevenue") return "medrevenu";
  if (normalized === "charm") return "charm";
  throw new Error(`Unsupported Availity project "${asText(value)}". Supported projects: Minimax, Medrevenu, Charm.`);
}

export function getMfaConfigForProject(projectId: string): AvailityMfaConfig {
  const configs = projectMfaConfig as Record<string, AvailityMfaConfig | undefined>;
  return configs[projectId] ?? configs.default ?? { totpSecretFormat: "base32" };
}

export function applyProjectColumnMapping(projectId: string, data: Record<string, string>): Record<string, string> {
  if (projectId === "charm") {
    const patientName = cleanCharmPatientName(findDataValue(data, ["Patient Name"])) ||
      [findDataValue(data, ["Patient first name"]), findDataValue(data, ["Patient last name"])].map(cleanCharmPatientName).filter(Boolean).join(" ");

    return {
      ...data,
      "Claim No": findDataValue(data, ["Invoice #", "Invoice Number", "Invoice"]) || data["Claim No"] || "",
      "Payer Name": findDataValue(data, ["Payer Name"]) || data["Payer Name"] || "",
      "Patient Name": patientName,
      "Patient DOB": findDataValue(data, ["Date Of Birth", "Date of Birth", "DOB"]) || data["Patient DOB"] || "",
      "Subscriber No": findDataValue(data, ["Insured's ID", "Insured ID", "Member ID", "Subscriber No"]) || data["Subscriber No"] || "",
      "Service Date": findDataValue(data, ["Date Of Service", "Date of Service", "DOS", "Service Date"]) || data["Service Date"] || "",
      Charges: findDataValue(data, ["Charges", "Billed Amount"]) || data.Charges || "",
      "Provider Name": findDataValue(data, ["Provider Name"]) || data["Provider Name"] || "",
      Group: findDataValue(data, ["Group", "Practice", "Organization Group"]) || data.Group || "",
    };
  }

  if (projectId !== "medrevenu") {
    return data;
  }

  const lineBilledAmount = findDataValue(data, ["Billed Amount"]) || data["Line Billed Amount"] || data.Charges || "";

  return {
    ...data,
    "Payer Name": findDataValue(data, ["Responsible Payer"]) || data["Payer Name"] || "",
    "Service Date": findDataValue(data, ["DOS"]) || data["Service Date"] || "",
    Charges: lineBilledAmount,
    "Line Billed Amount": lineBilledAmount,
    "Account Number": findDataValue(data, ["Account Number", "Account No", "Account"]) || data["Account Number"] || "",
    Episode_DOS: findDataValue(data, ["Episode_DOS", "Episode DOS", "Episode Dos"]) || data.Episode_DOS || "",
    Group: findDataValue(data, ["Group"]) || data.Group || "",
    "Subscriber No": findDataValue(data, ["Member ID"]) || data["Subscriber No"] || "",
  };
}

export function applyProjectPreprocessing(projectId: string, rows: AvailityInputRow[]): AvailityInputRow[] {
  if (projectId !== "medrevenu") {
    return rows;
  }

  const totals = new Map<string, number>();
  for (const row of rows) {
    const accountNumber = findRowValue(row, ["Account Number", "Account No", "Account"]);
    const episodeDos = findRowValue(row, ["Episode_DOS", "Episode DOS", "Episode Dos"]);
    const billedAmount = parseMoney(findRowValue(row, ["Line Billed Amount", "Billed Amount", "Charges"]));
    if (!accountNumber || !episodeDos || billedAmount == null) {
      continue;
    }

    const groupKey = `${normalizeLookup(accountNumber)}|${normalizeLookup(episodeDos)}`;
    totals.set(groupKey, (totals.get(groupKey) || 0) + billedAmount);
  }

  return rows.map((row) => {
    const accountNumber = findRowValue(row, ["Account Number", "Account No", "Account"]);
    const episodeDos = findRowValue(row, ["Episode_DOS", "Episode DOS", "Episode Dos"]);
    const groupKey = `${normalizeLookup(accountNumber)}|${normalizeLookup(episodeDos)}`;
    const total = totals.get(groupKey);
    if (!accountNumber || !episodeDos || total == null) {
      return row;
    }

    return {
      ...row,
      data: {
        ...row.data,
        Charges: formatMoney(total),
        "Claim Level Billed Amount": formatMoney(total),
      },
    };
  });
}

export function getOrganizationForRow(projectId: string, row: AvailityInputRow): string | undefined {
  const projectMap = (projectOrganizationMapping as Record<string, Record<string, string | null>>)[projectId];
  if (!projectMap || Object.keys(projectMap).length === 0) {
    return undefined;
  }

  const group = findRowValue(row, ["Group", "Group Name", "Group Code", "Practice", "Organization Group"]);
  if (!group) {
    throw new Error(`${projectId} Availity rows require a Group column value to select the organization.`);
  }

  const organization = Object.entries(projectMap).find(([mappedGroup]) => normalizeLookup(mappedGroup) === normalizeLookup(group))?.[1];
  if (!organization) {
    throw new Error(`No Availity organization mapping found for ${projectId} group "${group}". Update project-organization-mapping.json.`);
  }

  return organization;
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
  if (projectId !== "medrevenu" && projectId !== "charm") {
    return undefined;
  }

  const group = findRowValue(row, ["Group", "Group Name", "Group Code", "Medical Group", "Medical Group Name", "Practice", "Organization Group"]);
  const rawInputProviderName = findRowValue(row, ["Provider Name", "Provider", "Rendering Provider"]);
  const inputProviderName = projectId === "charm" ? cleanCharmProviderName(rawInputProviderName) : rawInputProviderName;
  if (!group && projectId === "charm") {
    if (inputProviderName) {
      return [inputProviderName];
    }
    throw new Error("Charm Availity rows require either a Group mapped in Provider_mapping_ava.xlsx or a Provider Name value.");
  }
  if (!group) {
    throw new Error(`${projectId} Availity rows require a Group column value to select the provider.`);
  }

  const match = providerMappings.find((mapping) => {
    return mapping.active
      && mapping.project === projectId
      && normalizeLookup(mapping.group) === normalizeLookup(group);
  });

  if (!match && projectId === "charm") {
    if (inputProviderName) {
      return [inputProviderName];
    }
    throw new Error(`No Availity provider mapping found for charm group "${group}", and no Provider Name fallback was supplied. Update Provider_mapping_ava.xlsx.`);
  }

  if (!match) {
    throw new Error(`No Availity provider mapping found for ${projectId} group "${group}". Update Provider_mapping_ava.xlsx.`);
  }

  return Array.from(new Set([match.providerName, inputProviderName].filter(Boolean)));
}
