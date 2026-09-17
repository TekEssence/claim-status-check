import path from "node:path";
import ExcelJS from "exceljs";
import { applyProjectColumnMapping, applyProjectPreprocessing, getProjectInputHeaders, normalizeProjectId } from "./project-config";
import type { AvailityCredentials, AvailityInput } from "./types";
import type { AvailityProviderSelectionMode, AvailitySelectionRule, AvailityTabId } from "./config/projects";

const SUPPORTED_PAYER_PATTERN = /\b(aetna|anthem|blue\s*cross|blue\s*shield|florida\s*blue|bcbs|bcbstx|regence|carefirst|carelon|bhomd|wellpoint|wellcare|humana|central\s*health|health\s*net|healthnet|molina|providence|scan|triwest|tricare)\b/i;

export function isRunnableAvailityPayerName(payerName: string): boolean {
  return SUPPORTED_PAYER_PATTERN.test(asText(payerName));
}

export function unsupportedAvailityPayerMessage(payerName: string): string {
  return `Payer "${payerName || "Unknown payer"}" is not supported now. This row was skipped.`;
}

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

function parseCsvRows(content: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    if (inQuotes) {
      if (char === "\"" && next === "\"") {
        field += "\"";
        index += 1;
      } else if (char === "\"") {
        inQuotes = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === "\"") {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      records.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  row.push(field);
  records.push(row);

  const headers = (records.shift() || []).map(normalizeHeader);
  const rows = records
    .map((record) => {
      const data: Record<string, string> = {};
      headers.forEach((header, index) => {
        if (header) data[header] = asText(record[index]);
      });
      return data;
    })
    .filter((data) => Object.values(data).some(Boolean));
  return { headers: headers.filter(Boolean), rows };
}

async function readTableFileRows(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  if (/\.csv$/i.test(file.name || "")) {
    return parseCsvRows(await file.text());
  }
  return readWorkbookRows(await file.arrayBuffer());
}

function splitList(value: string): string[] {
  return String(value || "")
    .split(/[;,]/)
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function normalizeChoice(value: string): string {
  return normalizeAlias(value);
}

function normalizeProviderModeValue(value: string): AvailityProviderSelectionMode {
  const normalized = normalizeChoice(value);
  if (normalized === "individualprovider" || normalized === "individualnpifirst") return "individualNpiFirst";
  if (normalized === "groupnamefirst") return "groupNameFirst";
  if (normalized === "groupnameonly") return "groupNameOnly";
  if (normalized === "none" || normalized === "directprovideridentifiers") return "none";
  throw new Error(`Unsupported Charm provider mode "${value}". Use Individual provider, groupNameFirst, groupNameOnly, or none.`);
}

function normalizeTabPriorityValue(value: string): AvailityTabId {
  const normalized = normalizeChoice(value);
  if (normalized === "servicedates" || normalized === "servicedate") return "serviceDates";
  if (normalized === "hipaastandard" || normalized === "hipaa") return "hipaaStandard";
  if (normalized === "member") return "member";
  if (normalized === "claimhistory") return "claimHistory";
  throw new Error(`Unsupported Charm tab "${value}". Use Service Dates, HIPAA Standard, Member, or Claim History.`);
}

function pushRuleWhen(rule: AvailitySelectionRule, conditionType: string, conditionValue: string): void {
  const type = normalizeChoice(conditionType);
  const values = splitList(conditionValue);
  if (!type || !values.length) return;

  const field = type === "practice" || type === "group" ? "practice"
    : type === "login" || type === "username" ? "login"
      : type === "state" ? "state"
        : type === "payer" ? "payer"
          : "";
  if (!field) {
    throw new Error(`Unsupported Charm selection rule condition type "${conditionType}". Use practice, login, state, or payer.`);
  }

  const existing = rule.when[field as keyof typeof rule.when];
  const merged = Array.from(new Set([
    ...(Array.isArray(existing) ? existing : existing ? [existing] : []),
    ...values,
  ]));
  const nextValue = merged.length === 1 ? merged[0] : merged;
  if (field === "practice") {
    rule.when.practice = values[0];
  } else if (field === "login") {
    rule.when.login = nextValue;
  } else if (field === "state") {
    rule.when.state = nextValue;
  } else if (field === "payer") {
    rule.when.payer = nextValue;
  }
}

function setRuleUse(rule: AvailitySelectionRule, key: string, value: string): void {
  const normalizedKey = normalizeChoice(key);
  const values = splitList(value);
  if (!normalizedKey || !values.length) return;

  if (normalizedKey === "organization") {
    rule.use.organization = values[0];
  } else if (normalizedKey === "providername") {
    rule.use.providerName = values[0];
  } else if (normalizedKey === "providermode") {
    rule.use.providerMode = normalizeProviderModeValue(values[0]);
  } else if (normalizedKey === "tabpriority" || normalizedKey === "tab") {
    const tabs = values.map(normalizeTabPriorityValue);
    rule.use.tabPriority = Array.from(new Set([...(rule.use.tabPriority || []), ...tabs]));
  } else {
    throw new Error(`Unsupported Charm selection rule output type "${key}".`);
  }
}

function parseWideSelectionRule(row: Record<string, string>): AvailitySelectionRule | undefined {
  const project = findValue(row, ["Project"]);
  if (project && normalizeProjectId(project) !== "charm") return undefined;

  const rule: AvailitySelectionRule = { when: {}, use: {} };
  const practice = findValue(row, ["Practice", "Group"]);
  const login = findValue(row, ["Login", "Username"]);
  const state = findValue(row, ["State", "State to choose in Availity", "Portal State"]);
  const payer = findValue(row, ["Payer to choose in Availity", "Portal Payer Name", "Payer"]);
  const organization = findValue(row, ["Organization to select", "Organization to select in Availity", "Use Organization", "Organization"]);
  const tab = findValue(row, ["Tab to use", "Use Tab Priority", "Tab Priority", "Tab"]);
  const providerName = findValue(row, ["Provider Name to select", "Use Provider Name", "Provider Name"]);
  const providerMode = findValue(row, ["Provider Mode", "Use Provider Mode"]);

  if (practice) rule.when.practice = practice;
  if (login) rule.when.login = login;
  if (state) rule.when.state = state;
  if (payer) rule.when.payer = payer;
  if (organization) rule.use.organization = organization;
  if (providerName) rule.use.providerName = providerName;
  if (providerMode) rule.use.providerMode = normalizeProviderModeValue(providerMode);
  if (tab) rule.use.tabPriority = splitList(tab).map(normalizeTabPriorityValue);

  if (!Object.keys(rule.when).length || !Object.keys(rule.use).length) return undefined;
  return rule;
}

function parseSelectionRules(rows: Record<string, string>[]): AvailitySelectionRule[] {
  const wideRules = rows.map(parseWideSelectionRule).filter((rule): rule is AvailitySelectionRule => Boolean(rule));
  if (wideRules.length) return wideRules;

  const grouped = new Map<string, AvailitySelectionRule>();

  for (const [index, row] of rows.entries()) {
    const ruleNumber = findValue(row, ["Rule Number", "rule_number", "Rule"]);
    const key = ruleNumber || String(index + 1);
    const rule = grouped.get(key) || { when: {}, use: {} };
    grouped.set(key, rule);

    pushRuleWhen(rule, findValue(row, ["When Field", "condition_type", "Condition Type"]), findValue(row, ["When Value", "condition_value", "Condition Value"]));
    setRuleUse(rule, "organization", findValue(row, ["Use Organization", "use_organization", "Organization"]));
    setRuleUse(rule, "providerName", findValue(row, ["Use Provider Name", "use_provider_name", "Provider Name"]));
    setRuleUse(rule, "providerMode", findValue(row, ["Use Provider Mode", "use_provider_mode", "Provider Mode"]));
    setRuleUse(rule, "tabPriority", findValue(row, ["Use Tab Priority", "use_tab_priority", "Tab Priority", "Tab"]));
  }

  return Array.from(grouped.values()).filter((rule) => Object.keys(rule.when).length && Object.keys(rule.use).length);
}

async function readOptionalSelectionRules(formData: FormData, projectId: string): Promise<AvailitySelectionRule[] | undefined> {
  const file = formData.get("selectionRulesFile");
  if (!(file instanceof File) || file.size === 0) {
    return undefined;
  }
  if (projectId !== "charm") {
    throw new Error("Selection rules upload is currently supported only for Charm Availity.");
  }
  const table = await readTableFileRows(file);
  const rules = parseSelectionRules(table.rows);
  if (!rules.length) {
    throw new Error("Charm selection rules file did not contain any usable rules.");
  }
  return rules;
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

export async function parseAvailityInput(formData: FormData): Promise<AvailityInput> {
  const credentialExcel = formData.get("credentialExcel");
  const inputExcel = formData.get("inputExcel");
  const projectId = normalizeProjectId(formData.get("projectId"));
  const selectionRules = await readOptionalSelectionRules(formData, projectId);

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

  return {
    credentials: parseCredentials(credentialRows.rows, projectId),
    projectId,
    selectionRules,
    inputHeaders: getProjectInputHeaders(projectId, inputWorkbook.headers),
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
