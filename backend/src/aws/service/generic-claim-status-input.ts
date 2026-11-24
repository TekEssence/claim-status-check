import ExcelJS from "exceljs";
import { maskIehpAccountLabel, validateServiceClaims } from "./iehp-input";
import type { PreparedServiceInput } from "./portal-dispatch";
import { resolveAerialSubportal } from "../../workflows/claim-status/portals/aerial/subportals/registry";
import { encodeServiceClaimWorkbook } from "./claim-workbook";
import { CLAIM_CREDENTIAL_SCOPE_COLUMNS } from "../../workflows/claim-status/credential-scopes";

type PortalConfig = {
  claimField: "claimExcel" | "inputExcel";
  loginField: "loginExcel" | "credentialExcel";
  loginColumns: Record<string, string>;
  accountKeys?: Array<"group" | "payer">;
  projectField?: string;
};

// These are the workbook columns consumed by the existing portal input readers.
export const claimStatusServicePortalConfigs = {
  aerial: {
    claimField: "inputExcel", loginField: "credentialExcel",
    loginColumns: { "Sub portal": "subportal", "Login URL": "login_url", Username: "username", Password: "password", Group: "group", "Claims URL": "claims_url", "Success URL Fragment": "success_url_fragment" },
    projectField: "aerialSubportal",
  },
  "all-care": {
    claimField: "inputExcel", loginField: "credentialExcel",
    loginColumns: { Group: "group", "Responsible Payer": "payer", URL: "login_url", Username: "username", Password: "password" },
    accountKeys: ["group", "payer"],
  },
  astrona: {
    claimField: "inputExcel", loginField: "credentialExcel",
    loginColumns: { Group: "group", "Responsible Payer": "payer", URL: "login_url", Username: "username", Password: "password" },
    accountKeys: ["group", "payer"],
  },
  "blue-shield": {
    claimField: "inputExcel", loginField: "credentialExcel",
    loginColumns: { Group: "group", URL: "login_url", "User Name": "username", Password: "password", "Claim Status URL": "claim_status_url", "MFA Mailbox": "mfa_mailbox" },
    accountKeys: ["group"],
  },
  cigna: {
    claimField: "inputExcel", loginField: "credentialExcel",
    loginColumns: { URL: "login_url", "User ID": "username", Password: "password" },
  },
  kaiser: {
    claimField: "inputExcel", loginField: "credentialExcel",
    loginColumns: { URL: "login_url", "User ID": "username", Password: "password" },
  },
  medpoint: {
    claimField: "claimExcel", loginField: "loginExcel",
    loginColumns: { "Login URL": "login_url", Username: "username", Password: "password" },
  },
  "my-family": {
    claimField: "inputExcel", loginField: "credentialExcel",
    loginColumns: { URL: "login_url", "User ID": "username", Password: "password" },
  },
  "optum-pro": {
    claimField: "inputExcel", loginField: "loginExcel",
    loginColumns: { "One Healthcare ID": "username", Password: "password", "Login URL": "login_url" },
  },
  physicians: {
    claimField: "inputExcel", loginField: "credentialExcel",
    loginColumns: { URL: "login_url", "User ID": "username", Password: "password" },
  },
  regal: {
    claimField: "claimExcel", loginField: "loginExcel",
    loginColumns: { Link: "login_url", Username: "username", Password: "password", "Preferred Email": "preferred_email", "Preferred Phone": "preferred_phone", "Preferred Phone Suffix": "preferred_phone_suffix", "Verification Method": "verification_method" },
  },
  uhc: {
    claimField: "claimExcel", loginField: "loginExcel",
    loginColumns: { URL: "login_url", Username: "username", Password: "password" },
    projectField: "projectId",
  },
  waystar: {
    claimField: "inputExcel", loginField: "loginExcel",
    loginColumns: { URL: "login_url", "User Name": "username", Password: "password", "Provider ID": "provider_id", "Provider Name": "provider_name", "Service Type Code": "service_type_code" },
  },
} as const satisfies Record<string, PortalConfig>;

export type GenericClaimStatusServicePortalId = keyof typeof claimStatusServicePortalConfigs;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error(`${label} is required.`);
  return value.trim();
}

function text(value: unknown): string { return value == null ? "" : String(value).trim(); }

async function workbook(headers: string[], rows: unknown[][], verification: Array<{ username: string; question: string; answer: string }> = [], mailConfiguration: Array<[string, string]> = []): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Sheet1");
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  if (verification.length) {
    const checks = book.addWorksheet("Verification");
    checks.addRow(["User Name", "Question", "Answer"]);
    verification.forEach((entry) => checks.addRow([entry.username, entry.question, entry.answer]));
  }
  if (mailConfiguration.length) {
    const sheet = book.addWorksheet("MailConfigurations");
    mailConfiguration.forEach(row => sheet.addRow(row));
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function prepareGenericClaimStatusServiceInput(
  portalId: GenericClaimStatusServicePortalId, body: unknown,
): Promise<PreparedServiceInput> {
  const source = record(body, "Request body");
  const config: PortalConfig = claimStatusServicePortalConfigs[portalId];
  const claims = validateServiceClaims(source.claims);
  const credentials = record(source.credentials, "credentials");
  const accountSource = credentials.accounts;
  const accounts = accountSource === undefined ? [credentials] : accountSource;
  if (!Array.isArray(accounts) || !accounts.length || accounts.length > 100) throw new Error("credentials.accounts must contain 1 to 100 accounts.");
  if (accounts.length > 1 && !config.accountKeys && portalId !== "aerial") {
    throw new Error(`${portalId} uses one credential account per job. Submit separate jobs for different accounts.`);
  }
  const parsedAccounts: Record<string, unknown>[] = accounts.map((item, index) => {
    const account = record(item, `credentials.accounts[${index}]`);
    return {
      ...account,
      username: nonempty(account.username, `credentials.accounts[${index}].username`),
      password: nonempty(account.password, `credentials.accounts[${index}].password`),
    };
  });
  const project = portalId === "aerial" ? resolveAerialSubportal(text(source.projectId)).id
    : portalId === "uhc" ? text(source.projectId).toLowerCase() || "minimax" : "";
  // This is transport encoding only. Every portal's native reader, row
  // filtering/validation and credential routing run in the shared worker.
  // Never reject this batch based on a claim's portal/business data here.
  const claimWorkbook = (await encodeServiceClaimWorkbook(claims)).buffer;
  const scopeKeys: Array<"group" | "payer"> = config.accountKeys ?? (portalId === "aerial" ? ["group"] : []);
  const inferenceKeys = scopeKeys.filter(key => parsedAccounts.length === 1 && !text(parsedAccounts[0][key]));
  const loginHeaders = [...Object.keys(config.loginColumns), ...inferenceKeys.map(key => CLAIM_CREDENTIAL_SCOPE_COLUMNS[key])];
  const accountRows = parsedAccounts.map((account, index) => {
    const row = Object.values(config.loginColumns).map(key => {
      if (key === "subportal") return text(account.subportal) || project;
      const value = text(account[key]);
      if (!value && !inferenceKeys.some(scope => scope === key) && (key === "username" || key === "password" || config.accountKeys?.some(scope => scope === key) || (portalId === "aerial" && project.toLowerCase().includes("citrus") && key === "group"))) {
        throw new Error(`credentials.accounts[${index}].${key} is required for ${portalId}.`);
      }
      if (!value && key === "login_url" && ["aerial", "all-care", "astrona", "blue-shield", "regal"].includes(portalId)) {
        throw new Error(`credentials.accounts[${index}].login_url is required for ${portalId}.`);
      }
      return value;
    });
    return [...row, ...inferenceKeys.map(() => true)];
  });
  const verification: Array<{ username: string; question: string; answer: string }> = [];
  if (portalId === "waystar") {
    parsedAccounts.forEach((account, accountIndex) => {
      const values = account.verification_answers;
      if (values === undefined) return;
      if (!Array.isArray(values) || values.length > 25) throw new Error(`credentials.accounts[${accountIndex}].verification_answers must be an array of at most 25 answers.`);
      values.forEach((entry, entryIndex) => {
        const answer = record(entry, `credentials.accounts[${accountIndex}].verification_answers[${entryIndex}]`);
        verification.push({
          username: String(account.username),
          question: nonempty(answer.question, `verification_answers[${entryIndex}].question`),
          answer: nonempty(answer.answer, `verification_answers[${entryIndex}].answer`),
        });
      });
    });
  }
  const mailConfiguration: Array<[string, string]> = [];
  if (portalId === "blue-shield" && credentials.mail_configuration !== undefined) {
    const entries = record(credentials.mail_configuration, "credentials.mail_configuration");
    const { MAIL_CONFIGURATION_KEYS } = await import("../../workflows/claim-status/portals/blue-shield/input");
    for (const [key, value] of Object.entries(entries)) {
      if (!MAIL_CONFIGURATION_KEYS.has(key)) throw new Error(`Unsupported Blue Shield mail configuration key: ${key}.`);
      mailConfiguration.push([key, nonempty(value, `credentials.mail_configuration.${key}`)]);
    }
  }
  const loginWorkbook = await workbook(loginHeaders, accountRows, verification, mailConfiguration);
  const claimFileName = `${portalId}-claims.xlsx`;
  const loginFileName = `${portalId}-login.xlsx`;
  const formFields: Record<string, string> = {
    integrationMode: "service", startIndex: "0",
    ...(config.projectField ? { [config.projectField]: project } : {}),
    ...(portalId === "uhc" ? { clientType: project } : {}),
    ...(portalId === "blue-shield" ? { checkpointId: claimFileName, resetCheckpoint: "false" } : {}),
  };
  return {
    claimCount: claims.length,
    files: [
      { field: config.claimField, filename: claimFileName, buffer: claimWorkbook },
      { field: config.loginField, filename: loginFileName, buffer: loginWorkbook },
    ],
    claimRowsJson: JSON.stringify(claims.map((claim, index) => ({ "Client Row Ref": claim.client_row_ref, __original_index: index }))),
    formFields,
    claimFileName,
    loginFileName,
    accountLabel: maskIehpAccountLabel(String(parsedAccounts[0].username)),
  };
}
