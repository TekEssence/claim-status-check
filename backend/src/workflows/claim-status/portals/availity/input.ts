import path from "node:path";
import ExcelJS from "exceljs";
import { applyProjectColumnMapping, applyProjectPreprocessing, normalizeProjectId } from "./project-config";
import type { AvailityCredentials, AvailityInput, AvailityInputRow } from "./types";

const SUPPORTED_PAYER_PATTERN = /\b(aetna|anthem|blue\s*cross|blue\s*shield|bcbs|bcbstx|wellpoint|wellcare|humana|health\s*net|healthnet|molina|triwest|tricare)\b/i;

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

function normalizeHeader(value: unknown): string {
  return asText(value).replace(/\s+/g, " ").trim();
}

function normalizeAlias(value: unknown): string {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeLoginUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("http") ? trimmed : `https://${trimmed}`;
}

function findValue(row: Record<string, string>, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalizeAlias));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalizeAlias(key)) && value) return value.trim();
  }
  return "";
}

async function readWorkbookRows(buffer: ArrayBuffer): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Workbook does not contain any worksheets.");
  }

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cell.value);
  });

  const rows: Record<string, string>[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const data: Record<string, string> = {};
    headers.forEach((header, colNumber) => {
      if (!header) return;
      data[header] = asText(row.getCell(colNumber).value);
    });
    if (Object.values(data).some(Boolean)) {
      rows.push(data);
    }
  });

  return { headers: headers.filter(Boolean), rows };
}

function parseCredentials(rows: Record<string, string>[], projectId: string): AvailityCredentials {
  const hasProjectColumn = rows.some((row) => findValue(row, ["Project", "Project Name", "Project ID"]));
  const candidateRows = hasProjectColumn
    ? rows.filter((row) => normalizeProjectId(findValue(row, ["Project", "Project Name", "Project ID"])) === projectId)
    : rows;

  if (hasProjectColumn && candidateRows.length === 0) {
    throw new Error(`Missing Availity login details for project "${projectId}". Login Excel Project column must match the selected frontend project.`);
  }

  for (const row of candidateRows) {
    const rawLoginUrl = findValue(row, ["Link", "URL", "Login URL", "Portal Link", "LOGIN_URL_AVA"]);
    const username = findValue(row, ["Username", "User Name", "User ID", "USERNAME_AVA1"]);
    const password = findValue(row, ["Password", "PASSWORD_AVA1"]);
    const totpSecret = findValue(row, ["Secret Key", "Secret", "TOTP Secret", "TOTP_SECRET"]);
    const successUrlFragment = findValue(row, ["Success URL Fragment", "SUCCESS_URL_FRAGMENT"]);

    if (rawLoginUrl && username && password && totpSecret) {
      return {
        loginUrl: normalizeLoginUrl(rawLoginUrl),
        username,
        password,
        totpSecret,
        successUrlFragment,
      };
    }
  }

  throw new Error(
    hasProjectColumn
      ? `Missing Availity login details for project "${projectId}". Login Excel must contain Project, Link, Username, Password, and Secret Key.`
      : "Missing Availity login details. Login Excel must contain Link, Username, Password, and Secret Key."
  );
}

function assertSupportedPayers(rows: AvailityInputRow[]): void {
  const unsupported = rows
    .map((row) => row.data["Payer Name"] || "")
    .filter((payerName) => payerName && !SUPPORTED_PAYER_PATTERN.test(payerName));

  if (unsupported.length) {
    const unique = Array.from(new Set(unsupported)).slice(0, 5);
    throw new Error(`Availity supports only Aetna, Anthem-CA, Blue Cross Blue Shield, Wellpoint, Wellcare, Humana, Health Net, Molina, and TRIWEST-TRICARE. Unsupported payer(s): ${unique.join(", ")}`);
  }
}

export async function parseAvailityInput(formData: FormData): Promise<AvailityInput> {
  const credentialExcel = formData.get("credentialExcel");
  const inputExcel = formData.get("inputExcel");
  const projectId = normalizeProjectId(formData.get("projectId"));

  if (!(credentialExcel instanceof File)) {
    throw new Error("Missing Availity login Excel file.");
  }
  if (!(inputExcel instanceof File)) {
    throw new Error("Missing Availity claim Excel file.");
  }

  const credentialRows = await readWorkbookRows(await credentialExcel.arrayBuffer());
  const inputWorkbook = await readWorkbookRows(await inputExcel.arrayBuffer());
  const mappedInputRows = inputWorkbook.rows.map((data, index) => ({
    input_row_id: index + 1,
    source_row_number: index + 2,
    data: applyProjectColumnMapping(projectId, data),
  }));
  const inputRows = applyProjectPreprocessing(projectId, mappedInputRows);

  if (!inputRows.length) {
    throw new Error("Availity claim Excel file contains no rows.");
  }

  assertSupportedPayers(inputRows);

  return {
    credentials: parseCredentials(credentialRows.rows, projectId),
    projectId,
    inputHeaders: inputWorkbook.headers,
    inputRows,
    claimFileName: inputExcel.name || "availity_claims.xlsx",
  };
}

export async function readAvailityPayerMapping(projectId = "minimax"): Promise<Map<string, string>> {
  const mappingPath = path.join(
    process.cwd(),
    "backend",
    "src",
    "workflows",
    "claim-status",
    "portals",
    "availity",
    "config",
    "Payer_mapping_ava.xlsx",
  );
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(mappingPath);
  const normalizedProjectId = normalizeAlias(projectId);
  const worksheet = workbook.worksheets.find((sheet) => normalizeAlias(sheet.name) === normalizedProjectId) ?? workbook.worksheets[0];
  if (!worksheet) {
    throw new Error("Availity payer mapping workbook does not contain any worksheets.");
  }

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cell.value);
  });

  const excelNameCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Payer name in excel"));
  const websiteNameCol = headers.findIndex((header) => normalizeAlias(header) === normalizeAlias("Payer name in website"));
  if (excelNameCol < 1 || websiteNameCol < 1) {
    throw new Error("Availity payer mapping must contain Payer name in excel and Payer name in website columns.");
  }

  const mapping = new Map<string, string>();
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const excelName = asText(row.getCell(excelNameCol).value);
    const websiteName = asText(row.getCell(websiteNameCol).value);
    if (excelName && websiteName) {
      mapping.set(asText(excelName).toLowerCase(), websiteName);
    }
  });

  return mapping;
}
