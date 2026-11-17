import ExcelJS from "exceljs";
import { validateServiceClaims, maskIehpAccountLabel, type PreparedClaim } from "./iehp-input";
import { medRevenueAvailityConfig } from "../../workflows/eligibility-verification/portals/availity/config/projects/medrevenue";
import { normalizeWaystarDate } from "../../workflows/eligibility-verification/portals/waystar/dates";
import { readHealthNetInput, readHealthNetCredentials } from "../../workflows/eligibility-verification/portals/healthnet/data";
import { readIehpInput, readIehpCredentials } from "../../workflows/eligibility-verification/portals/iehp/data";
import { readMediCalInput, readMediCalCredentials } from "../../workflows/eligibility-verification/portals/medi-cal/data";
import { readTriZettoInput, readTriZettoCredentials } from "../../workflows/eligibility-verification/portals/trizetto/data";
import { readWaystarEligibilityWorkbook } from "../../workflows/eligibility-verification/portals/waystar/input";
import { readWaystarCredentialProfiles, findWaystarCredentialsForPayer } from "../../workflows/eligibility-verification/portals/waystar/credentials";
import { getWaystarPayer } from "../../workflows/eligibility-verification/portals/waystar/payer-registry";
import { medRevenueWaystarConfig } from "../../workflows/eligibility-verification/portals/waystar/config/projects/medrevenue";
import { eligibilityServiceProject, type EligibilityServicePortal } from "./eligibility-portals";
import { readUhcEligibilityCredentials } from "../../workflows/eligibility-verification/portals/uhc/credentials";
import { readUhcEligibilityInputRows } from "../../workflows/eligibility-verification/portals/uhc/payers/uhc-wellmed/workflow";

type EligibilityServiceCredentials = {
  login_url: string; username: string; password: string;
  totp_secret?: string; success_url_fragment?: string;
  payer?: string; provider_id?: string; provider_name?: string; service_type_code?: string;
  verification_answers?: Array<{ question: string; answer: string }>;
};

export type EligibilityServiceInput = {
  projectId: "medrevenue" | "minimax";
  claims: PreparedClaim[];
  credentials: EligibilityServiceCredentials & { accounts?: EligibilityServiceCredentials[] };
};

function requiredString(value: unknown, name: string, maxLength = 2048): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${name} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

function normalized(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const requiredFields = ["Primary Insurance Name", "Patient Name", "Member ID", "DOB", "DOS"] as const;
const supportedPayers = Object.values(medRevenueAvailityConfig.payers ?? {}).flatMap((payer) =>
  [payer.portalPayerName, ...payer.insuranceNameAliases].map(normalized));

export function validateEligibilityServiceInput(value: unknown, portal: EligibilityServicePortal = "availity"): EligibilityServiceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object.");
  const source = value as Record<string, unknown>;
  const projectId = eligibilityServiceProject(portal);
  if (source.projectId !== projectId) {
    throw new Error(`Eligibility service projectId must be "${projectId}" for ${portal}.`);
  }
  const credentials = source.credentials;
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error("Eligibility credentials are required.");
  }
  const credentialSource = credentials as Record<string, unknown>;
  const accounts = portal === "waystar" && credentialSource.accounts !== undefined ? credentialSource.accounts : [credentialSource];
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 100) throw new Error("credentials.accounts must contain 1 to 100 accounts.");
  if (portal !== "waystar" && credentialSource.accounts !== undefined) throw new Error(`${portal} accepts one credential account per job.`);
  const parsed = accounts.map((value): EligibilityServiceCredentials => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Each credential account must be an object.");
    const account = value as Record<string, unknown>;
    const answers = account.verification_answers;
    if (answers !== undefined && (!Array.isArray(answers) || answers.length > 25)) throw new Error("verification_answers must contain at most 25 answers.");
    return {
      login_url: requiredString(account.login_url, "credentials.login_url"),
      username: requiredString(account.username, "credentials.username", 500),
      password: requiredString(account.password, "credentials.password"),
      ...Object.fromEntries(["totp_secret", "success_url_fragment", ...(portal === "waystar" ? ["payer", "provider_id", "provider_name", "service_type_code"] : [])]
        .filter(key => account[key] !== undefined && account[key] !== "").map(key => [key, requiredString(account[key], `credentials.${key}`)])),
      ...(portal === "waystar" && Array.isArray(answers) ? { verification_answers: answers.map(entry => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Each verification answer must be an object.");
        return { question: requiredString(entry.question, "verification_answers.question"), answer: requiredString(entry.answer, "verification_answers.answer") };
      }) } : {}),
    };
  });
  if (portal === "uhc" && !parsed[0].totp_secret) throw new Error("UHC credentials.totp_secret is required.");
  const claims = validateServiceClaims(source.claims);
  for (const [index, claim] of claims.entries()) {
    const missing = portal === "availity" ? requiredFields.filter((field) => !String(claim.data[field] ?? "").trim()) : [];
    if (missing.length) throw new Error(`Eligibility row ${index + 1} is missing ${missing.join(", ")}.`);
    if (portal === "availity" && !supportedPayers.includes(normalized(claim.data["Primary Insurance Name"]))) {
      throw new Error(`Eligibility row ${index + 1} has an unsupported Primary Insurance Name for MedRevenue Availity.`);
    }
    for (const field of portal === "availity" ? ["DOB", "DOS"] as const : []) {
      try {
        normalizeWaystarDate(String(claim.data[field]));
      } catch {
        throw new Error(`Eligibility row ${index + 1} ${field} must be a valid MM/DD/YYYY, DD/MM/YYYY, or YYYY-MM-DD date.`);
      }
    }
  }
  return {
    projectId,
    claims,
    credentials: { ...parsed[0], ...(portal === "waystar" ? { accounts: parsed } : {}) },
  };
}

export async function generateEligibilityServiceInput(input: EligibilityServiceInput, portal: EligibilityServicePortal = "availity") {
  const headers = ["Client Row Ref", "Project", ...new Set([
    ...(portal === "availity" ? requiredFields : []), ...input.claims.flatMap(claim => Object.keys(claim.data)),
  ].filter(key => key !== "Project"))];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Input");
  sheet.addRow(headers);
  for (const claim of input.claims) {
    sheet.addRow(headers.map((header) => header === "Client Row Ref" ? claim.client_row_ref
      : header === "Project" ? input.projectId
        : portal === "availity" && (header === "DOB" || header === "DOS") ? normalizeWaystarDate(String(claim.data[header]))
          : claim.data[header] ?? ""));
  }

  const credentialWorkbook = new ExcelJS.Workbook();
  const credentialSheet = credentialWorkbook.addWorksheet("Login");
  credentialSheet.addRow(["Project", "Portal", "Link", "Username", "Password", "Secret Key", "Success URL Fragment",
    ...(portal === "waystar" ? ["URL", "Payer", "Provider ID", "Provider Name", "Service Type Code"] : [])]);
  const accounts = input.credentials.accounts ?? [input.credentials];
  for (const account of accounts) credentialSheet.addRow([input.projectId, portal, account.login_url, account.username,
    account.password, account.totp_secret ?? "", account.success_url_fragment ?? "",
    ...(portal === "waystar" ? [account.login_url, account.payer ?? "", account.provider_id ?? "", account.provider_name ?? "", account.service_type_code ?? ""] : [])]);
  if (portal === "waystar" && accounts.some(account => account.verification_answers?.length)) {
    const verification = credentialWorkbook.addWorksheet("Verification");
    verification.addRow(["Username", "Question", "Answer"]);
    for (const account of accounts) for (const answer of account.verification_answers ?? []) verification.addRow([account.username, answer.question, answer.answer]);
  }

  const inputWorkbook = Buffer.from(await workbook.xlsx.writeBuffer());
  const loginWorkbook = Buffer.from(await credentialWorkbook.xlsx.writeBuffer());
  if (portal !== "availity") {
    const inputFile = new File([new Uint8Array(inputWorkbook)], "eligibility.xlsx");
    const credentialFile = new File([new Uint8Array(loginWorkbook)], "eligibility-login.xlsx");
    let selectedRefs: unknown[];
    if (portal === "uhc") {
      await readUhcEligibilityCredentials(credentialFile, input.projectId);
      const routing = readUhcEligibilityInputRows(sheet);
      selectedRefs = [...routing.rows, ...routing.skippedRows].map(row => sheet.getRow(row.worksheetRow).getCell(1).text);
    } else if (portal === "waystar") {
      const routing = await readWaystarEligibilityWorkbook(inputFile, credentialFile, medRevenueWaystarConfig);
      if (routing.unsupportedRows.length) throw new Error("Waystar claims contain an unsupported payer for MedRevenue.");
      const profiles = await readWaystarCredentialProfiles(credentialFile);
      if (routing.batches.some(batch => !findWaystarCredentialsForPayer(profiles, getWaystarPayer(batch.payerId, "medrevenue"), "medrevenue",
        { allowUnscopedCredentials: medRevenueWaystarConfig.allowUnscopedCredentials }))) throw new Error("Waystar credentials do not cover every requested payer.");
      selectedRefs = routing.batches.flatMap(batch => batch.rows.map(row => row.raw["Client Row Ref"]));
    } else {
      const readers = { healthnet: [readHealthNetInput, readHealthNetCredentials], iehp: [readIehpInput, readIehpCredentials],
        medical: [readMediCalInput, readMediCalCredentials], trizetto: [readTriZettoInput, readTriZettoCredentials] } as const;
      const [readInput, readCredentials] = readers[portal];
      const rows = await readInput(inputFile); await readCredentials(credentialFile);
      selectedRefs = rows.map(row => row.raw["Client Row Ref"]);
    }
    if (selectedRefs.length !== input.claims.length || new Set(selectedRefs).size !== input.claims.length) {
      throw new Error(`${portal} input does not select every submitted claim. Check Primary Insurance Name and portal-specific fields.`);
    }
  }

  return {
    inputWorkbook,
    credentialWorkbook: loginWorkbook,
    claimRowsJson: JSON.stringify(input.claims.map((claim, index) => ({ "Client Row Ref": claim.client_row_ref, __original_index: index }))),
    accountLabel: maskIehpAccountLabel(input.credentials.username),
  };
}
