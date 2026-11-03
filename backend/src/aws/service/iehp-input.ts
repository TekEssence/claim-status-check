import ExcelJS from "exceljs";

export type PreparedClaim = {
  client_row_ref: string;
  data: Record<string, string | number | boolean | null>;
};

export type IehpServiceCredentials = {
  login_url: string;
  username: string;
  password: string;
  claim_status_url?: string;
};

export function maskIehpAccountLabel(username: string): string {
  const value = username.trim();
  const at = value.lastIndexOf("@");
  if (at > 0 && at < value.length - 1) return `${value[0]}***@${value.slice(at + 1)}`;
  return `${value[0] ?? "*"}***${value.length > 4 ? value[value.length - 1] : ""}`;
}

export type IehpServiceInput = {
  claims: PreparedClaim[];
  credentials: IehpServiceCredentials;
};

export type GeneratedIehpInput = {
  claimWorkbook: Buffer;
  loginWorkbook: Buffer;
  claimRowsJson: string;
};

const MAX_SERVICE_CLAIMS_PER_JOB = 10_000;

function requiredString(value: unknown, label: string, maxLength = 500): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value.trim();
}

export function validateServiceClaims(value: unknown): PreparedClaim[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SERVICE_CLAIMS_PER_JOB) {
    throw new Error(`claims must contain between 1 and ${MAX_SERVICE_CLAIMS_PER_JOB} rows.`);
  }
  const seen = new Set<string>();
  return value.map((claim, index) => {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) throw new Error(`Claim ${index + 1} is invalid.`);
    const source = claim as Record<string, unknown>;
    const clientRowRef = requiredString(source.client_row_ref, `Claim ${index + 1} client_row_ref`, 160);
    if (seen.has(clientRowRef)) throw new Error(`Duplicate client_row_ref: ${clientRowRef}.`);
    seen.add(clientRowRef);
    if (!source.data || typeof source.data !== "object" || Array.isArray(source.data)) {
      throw new Error(`Claim ${index + 1} data must be an object.`);
    }
    const data = source.data as Record<string, unknown>;
    if (Object.keys(data).length > 100) throw new Error(`Claim ${index + 1} has too many fields.`);
    for (const [key, field] of Object.entries(data)) {
      if (!key.trim() || key.length > 120 || key === "Client Row Ref" || key === "__original_index" || key.startsWith("Bot")) {
        throw new Error(`Claim ${index + 1} has an unsupported field name.`);
      }
      if (field !== null && typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean") {
        throw new Error(`Claim ${index + 1} field ${key} must be scalar.`);
      }
    }
    return { client_row_ref: clientRowRef, data: data as PreparedClaim["data"] };
  });
}

function validateIehpClaims(value: unknown): PreparedClaim[] {
  return validateServiceClaims(value).map((claim, index) => {
    if (!String(claim.data["Member Policy ID"] ?? "").trim() || !String(claim.data["Date Of Service"] ?? "").trim()) {
      throw new Error(`Claim ${index + 1} requires Member Policy ID and Date Of Service.`);
    }
    return claim;
  });
}

export function validateIehpServiceInput(value: unknown): IehpServiceInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Request body must be an object.");
  const source = value as Record<string, unknown>;
  const credentialSource = source.credentials;
  if (!credentialSource || typeof credentialSource !== "object" || Array.isArray(credentialSource)) {
    throw new Error("IEHP credentials are required.");
  }
  const credentials = credentialSource as Record<string, unknown>;
  return {
    claims: validateIehpClaims(source.claims),
    credentials: {
      login_url: requiredString(credentials.login_url, "credentials.login_url", 2048),
      username: requiredString(credentials.username, "credentials.username"),
      password: requiredString(credentials.password, "credentials.password", 2048),
      ...(credentials.claim_status_url ? { claim_status_url: requiredString(credentials.claim_status_url, "credentials.claim_status_url", 2048) } : {}),
    },
  };
}

export async function generateIehpServiceInput(input: IehpServiceInput): Promise<GeneratedIehpInput> {
  const rows: Array<Record<string, string | number | boolean | null>> = input.claims.map((claim, index) => ({ ...claim.data, "Client Row Ref": claim.client_row_ref, __original_index: index }));
  const headers = ["Client Row Ref", ...new Set(input.claims.flatMap((claim) => Object.keys(claim.data)))];
  const claimWorkbook = new ExcelJS.Workbook();
  const claimSheet = claimWorkbook.addWorksheet("Claims");
  claimSheet.addRow(headers);
  for (const row of rows) claimSheet.addRow(headers.map((header) => row[header] ?? ""));

  const loginWorkbook = new ExcelJS.Workbook();
  const loginSheet = loginWorkbook.addWorksheet("Login");
  loginSheet.addRow(["URL", "User Name", "Password", "Claim Status URL"]);
  loginSheet.addRow([
    input.credentials.login_url,
    input.credentials.username,
    input.credentials.password,
    input.credentials.claim_status_url ?? "",
  ]);
  return {
    claimWorkbook: Buffer.from(await claimWorkbook.xlsx.writeBuffer()),
    loginWorkbook: Buffer.from(await loginWorkbook.xlsx.writeBuffer()),
    claimRowsJson: JSON.stringify(rows),
  };
}
