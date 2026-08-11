import * as XLSX from "xlsx";
import type { AstronaCredentialBatch, AstronaCredentials, AstronaInput, AstronaInputRow } from "./types";

function asText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function key(value: unknown): string {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  for (const alias of aliases) {
    const wanted = key(alias);
    for (const [header, value] of Object.entries(row)) {
      if (key(header) === wanted) {
        const text = asText(value);
        if (text) return text;
      }
    }
  }
  return "";
}

function normalizeUrl(value: string): string {
  return value.startsWith("http") ? value : `https://${value}`;
}

function readRows(buffer: ArrayBuffer): Record<string, unknown>[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("Astrona workbook does not contain a worksheet.");
  return XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
}

export function readAstronaCredentials(buffer: ArrayBuffer): AstronaCredentials[] {
  return readRows(buffer).map((row, index) => {
    const group = findValue(row, ["Group", "IPA", "Provider Group"]);
    const payer = findValue(row, ["Responsible Payer", "Payer", "Payer Name"]);
    const rawUrl = findValue(row, ["URL", "Login URL", "Portal URL"]);
    const username = findValue(row, ["Username", "User Name", "Email"]);
    const password = findValue(row, ["Password"]);
    const missing = [!group && "Group", !payer && "Payer", !rawUrl && "URL", !username && "Username", !password && "Password"].filter(Boolean);
    if (missing.length) throw new Error(`Astrona login Excel row ${index + 2} is missing ${missing.join(", ")}.`);
    return { group, payer, loginUrl: normalizeUrl(rawUrl), username, password };
  });
}

export function readAstronaInputRows(buffer: ArrayBuffer): AstronaInputRow[] {
  return readRows(buffer).map((row, index) => {
    const group = findValue(row, ["Group", "IPA", "Provider Group"]);
    const payer = findValue(row, ["Responsible Payer", "Payer", "Payer Name"]);
    const memberId = findValue(row, ["Member ID", "Member Id", "Subscriber ID", "Subscriber No"]);
    const memberName = findValue(row, ["Member Name", "Patient Name", "Patient"]);
    const dob = findValue(row, ["DOB", "Date of Birth", "Member DOB", "Patient DOB", "Birth Date"]);
    const dos = findValue(row, ["DOS", "Date of Service", "Service Date", "Service From Date", "From Date"]);
    const cptCode = findValue(row, ["CPT", "CPT Code", "Procedure Code", "Procedure", "Service Code"]);
    const missing = [!group && "Group", !payer && "Responsible Payer", !memberId && !memberName && "Member ID or Member Name"].filter(Boolean);
    return {
      inputRowId: index + 2,
      sourceRow: { ...row },
      group,
      payer,
      memberId,
      memberName,
      dob,
      dos,
      cptCode,
      validationStatus: missing.length ? "invalid" : "valid",
      validationMessage: missing.length ? `Missing ${missing.join(", ")}.` : "",
    } satisfies AstronaInputRow;
  }).filter((row) => row.group || row.payer || row.memberId || row.memberName);
}

export function routeAstronaRows(rows: AstronaInputRow[], credentials: AstronaCredentials[]): {
  batches: AstronaCredentialBatch[];
  unmappedRows: AstronaInputRow[];
} {
  const credentialMap = new Map(credentials.map((credential) => [`${key(credential.group)}::${key(credential.payer)}`, credential]));
  const batches = new Map<string, AstronaCredentialBatch>();
  const unmappedRows: AstronaInputRow[] = [];
  for (const row of rows.filter((candidate) => candidate.validationStatus === "valid")) {
    const routingKey = `${key(row.group)}::${key(row.payer)}`;
    const credential = credentialMap.get(routingKey);
    if (!credential) {
      unmappedRows.push(row);
      continue;
    }
    const batchKey = `${routingKey}::${credential.loginUrl.toLowerCase()}::${credential.username.toLowerCase()}`;
    const existing = batches.get(batchKey);
    if (existing) existing.rows.push(row);
    else batches.set(batchKey, { credentials: credential, rows: [row] });
  }
  return { batches: [...batches.values()], unmappedRows };
}

export async function parseAstronaInput(formData: FormData): Promise<AstronaInput> {
  const credentialExcel = formData.get("credentialExcel");
  const inputExcel = formData.get("inputExcel");
  if (!(credentialExcel instanceof File)) throw new Error("Missing Astrona login Excel file.");
  if (!(inputExcel instanceof File)) throw new Error("Missing Astrona claim Excel file.");
  return {
    credentialWorkbookBuffer: await credentialExcel.arrayBuffer(),
    inputWorkbookBuffer: await inputExcel.arrayBuffer(),
  };
}
