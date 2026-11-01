import ExcelJS from "exceljs";
import { validateServiceClaims, maskIehpAccountLabel, type PreparedClaim } from "./iehp-input";
import { medRevenueAvailityConfig } from "../../workflows/eligibility-verification/portals/availity/config/projects/medrevenue";
import { normalizeWaystarDate } from "../../workflows/eligibility-verification/portals/waystar/dates";

export type EligibilityServiceInput = {
  projectId: "medrevenue";
  claims: PreparedClaim[];
  credentials: {
    login_url: string;
    username: string;
    password: string;
    totp_secret?: string;
    success_url_fragment?: string;
  };
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

export function validateEligibilityServiceInput(value: unknown): EligibilityServiceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object.");
  const source = value as Record<string, unknown>;
  if (source.projectId !== "medrevenue") {
    throw new Error('Eligibility service projectId must be "medrevenue" for the supported Availity member-search runner.');
  }
  const credentials = source.credentials;
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
    throw new Error("Eligibility credentials are required.");
  }
  const credentialSource = credentials as Record<string, unknown>;
  const claims = validateServiceClaims(source.claims);
  for (const [index, claim] of claims.entries()) {
    const missing = requiredFields.filter((field) => !String(claim.data[field] ?? "").trim());
    if (missing.length) throw new Error(`Eligibility row ${index + 1} is missing ${missing.join(", ")}.`);
    if (!supportedPayers.includes(normalized(claim.data["Primary Insurance Name"]))) {
      throw new Error(`Eligibility row ${index + 1} has an unsupported Primary Insurance Name for MedRevenue Availity.`);
    }
    for (const field of ["DOB", "DOS"] as const) {
      try {
        normalizeWaystarDate(String(claim.data[field]));
      } catch {
        throw new Error(`Eligibility row ${index + 1} ${field} must be a valid MM/DD/YYYY, DD/MM/YYYY, or YYYY-MM-DD date.`);
      }
    }
  }
  return {
    projectId: "medrevenue",
    claims,
    credentials: {
      login_url: requiredString(credentialSource.login_url, "credentials.login_url"),
      username: requiredString(credentialSource.username, "credentials.username", 500),
      password: requiredString(credentialSource.password, "credentials.password"),
      ...(credentialSource.totp_secret ? { totp_secret: requiredString(credentialSource.totp_secret, "credentials.totp_secret") } : {}),
      ...(credentialSource.success_url_fragment ? { success_url_fragment: requiredString(credentialSource.success_url_fragment, "credentials.success_url_fragment") } : {}),
    },
  };
}

export async function generateEligibilityServiceInput(input: EligibilityServiceInput) {
  const headers = ["Client Row Ref", "Project", ...requiredFields,
    ...new Set(input.claims.flatMap((claim) => Object.keys(claim.data)).filter((key) => !requiredFields.includes(key as typeof requiredFields[number]) && key !== "Project"))];
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Input");
  sheet.addRow(headers);
  for (const claim of input.claims) {
    sheet.addRow(headers.map((header) => header === "Client Row Ref" ? claim.client_row_ref
      : header === "Project" ? "MedRevenue"
        : header === "DOB" || header === "DOS" ? normalizeWaystarDate(String(claim.data[header]))
          : claim.data[header] ?? ""));
  }

  const credentialWorkbook = new ExcelJS.Workbook();
  const credentialSheet = credentialWorkbook.addWorksheet("Login");
  credentialSheet.addRow(["Project", "Portal", "Link", "Username", "Password", "Secret Key", "Success URL Fragment"]);
  credentialSheet.addRow(["MedRevenue", "availity", input.credentials.login_url, input.credentials.username,
    input.credentials.password, input.credentials.totp_secret ?? "", input.credentials.success_url_fragment ?? ""]);

  return {
    inputWorkbook: Buffer.from(await workbook.xlsx.writeBuffer()),
    credentialWorkbook: Buffer.from(await credentialWorkbook.xlsx.writeBuffer()),
    claimRowsJson: JSON.stringify(input.claims.map((claim, index) => ({ "Client Row Ref": claim.client_row_ref, __original_index: index }))),
    accountLabel: maskIehpAccountLabel(input.credentials.username),
  };
}
