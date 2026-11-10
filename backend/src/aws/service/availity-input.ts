import ExcelJS from "exceljs";
import { applyProjectColumnMapping, getRequiredFieldsForProject, normalizeProjectId } from "../../workflows/claim-status/portals/availity/project-config";
import { maskIehpAccountLabel, validateServiceClaims, type PreparedClaim } from "./iehp-input";
import { readOptionalSelectionRules } from "../../workflows/claim-status/portals/availity/input";

export type AvailityServiceInput = {
  claims: PreparedClaim[];
  projectId: string;
  selectionRules?: Array<Record<string, string | number | boolean | null>>;
  credentials: {
    login_url: string;
    username: string;
    password: string;
    totp_secret: string;
    success_url_fragment?: string;
  };
};

function requiredString(value: unknown, name: string, maxLength = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

export function validateAvailityServiceInput(value: unknown): AvailityServiceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object.");
  const source = value as Record<string, unknown>;
  const projectId = normalizeProjectId(source.projectId);
  const credentialSource = source.credentials;
  if (!credentialSource || typeof credentialSource !== "object" || Array.isArray(credentialSource)) {
    throw new Error("Availity credentials are required.");
  }
  const credentials = credentialSource as Record<string, unknown>;
  const claims = validateServiceClaims(source.claims);
  let selectionRules: AvailityServiceInput["selectionRules"];
  if (source.selection_rules !== undefined) {
    if (projectId !== "charm") throw new Error("Selection rules upload is currently supported only for Charm Availity.");
    if (!Array.isArray(source.selection_rules) || !source.selection_rules.length || source.selection_rules.length > 1000) {
      throw new Error("selection_rules must contain 1 to 1000 selection-rule rows.");
    }
    // Use the same scalar row validation as claims; these rows use the existing selection workbook headers.
    selectionRules = validateServiceClaims(source.selection_rules.map((data, index) => ({ client_row_ref: String(index), data })))
      .map(row => row.data);
  }
  const requiredFields = getRequiredFieldsForProject(projectId);
  for (const [index, claim] of claims.entries()) {
    const data = Object.fromEntries(Object.entries(claim.data).map(([key, field]) => [key, field == null ? "" : String(field)]));
    const mapped = applyProjectColumnMapping(projectId, data);
    const missing = requiredFields.filter((field) => !mapped[field]?.trim());
    if (missing.length) throw new Error(`Claim ${index + 1} is missing ${missing.join(", ")}.`);
    if (!/^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/.test(mapped["Service Date"])) {
      throw new Error(`Claim ${index + 1} Service Date must use MM/DD/YYYY.`);
    }
    if (projectId === "charm" && !mapped["Provider NPI"] && !mapped["Provider Tax ID"]) {
      throw new Error(`Claim ${index + 1} requires Provider NPI or Provider Tax ID.`);
    }
    if (projectId === "medrevenu" && !mapped.Group) {
      throw new Error(`Claim ${index + 1} requires Group for provider selection.`);
    }
  }

  return {
    claims,
    projectId,
    ...(selectionRules ? { selectionRules } : {}),
    credentials: {
      login_url: requiredString(credentials.login_url, "credentials.login_url"),
      username: requiredString(credentials.username, "credentials.username", 500),
      password: requiredString(credentials.password, "credentials.password"),
      totp_secret: requiredString(credentials.totp_secret, "credentials.totp_secret"),
      ...(credentials.success_url_fragment ? { success_url_fragment: requiredString(credentials.success_url_fragment, "credentials.success_url_fragment") } : {}),
    },
  };
}

export async function generateAvailityServiceInput(input: AvailityServiceInput) {
  const headers = ["Client Row Ref", ...new Set(input.claims.flatMap((claim) => Object.keys(claim.data)))];
  const claimWorkbook = new ExcelJS.Workbook();
  const claimSheet = claimWorkbook.addWorksheet("Claims");
  claimSheet.addRow(headers);
  for (const claim of input.claims) {
    claimSheet.addRow(headers.map((header) => header === "Client Row Ref" ? claim.client_row_ref : claim.data[header] ?? ""));
  }

  const credentialWorkbook = new ExcelJS.Workbook();
  const credentialSheet = credentialWorkbook.addWorksheet("Login");
  credentialSheet.addRow(["Project", "Link", "Username", "Password", "Secret Key", "Success URL Fragment"]);
  credentialSheet.addRow([
    input.projectId, input.credentials.login_url, input.credentials.username, input.credentials.password,
    input.credentials.totp_secret, input.credentials.success_url_fragment ?? "",
  ]);

  let selectionRulesWorkbook: Buffer | undefined;
  if (input.selectionRules) {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Selection Rules");
    const columns = [...new Set(input.selectionRules.flatMap(row => Object.keys(row)))];
    sheet.addRow(columns);
    input.selectionRules.forEach(row => sheet.addRow(columns.map(column => row[column] ?? "")));
    selectionRulesWorkbook = Buffer.from(await book.xlsx.writeBuffer());
    const form = new FormData();
    form.set("selectionRulesFile", new File([new Uint8Array(selectionRulesWorkbook)], "selection-rules.xlsx"));
    await readOptionalSelectionRules(form, input.projectId);
  }

  return {
    claimWorkbook: Buffer.from(await claimWorkbook.xlsx.writeBuffer()),
    credentialWorkbook: Buffer.from(await credentialWorkbook.xlsx.writeBuffer()),
    claimRowsJson: JSON.stringify(input.claims.map((claim, index) => ({ "Client Row Ref": claim.client_row_ref, __original_index: index }))),
    accountLabel: maskIehpAccountLabel(input.credentials.username),
    selectionRulesWorkbook,
  };
}
