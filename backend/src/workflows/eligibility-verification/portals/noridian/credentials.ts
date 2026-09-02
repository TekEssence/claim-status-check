import ExcelJS from "exceljs";

const DEFAULT_NORIDIAN_LOGIN_URL = "https://esp.noridianmedicareportal.com/nidp/app/login?id=AC_NMP&option=credential&sid=0";

function normalizeNoridianLoginUrl(value: string): string {
  const candidate = value.trim();
  if (!candidate) return DEFAULT_NORIDIAN_LOGIN_URL;
  try {
    const url = new URL(candidate.startsWith("http") ? candidate : `https://${candidate}`);
    // Public/home NMP URLs sometimes time out before redirecting to the
    // identity provider. Start directly at the stable credential endpoint.
    if (url.hostname.toLowerCase().endsWith("noridianmedicareportal.com")) {
      return DEFAULT_NORIDIAN_LOGIN_URL;
    }
    return url.toString();
  } catch {
    return DEFAULT_NORIDIAN_LOGIN_URL;
  }
}

export type NoridianCredentials = {
  loginUrl: string;
  username: string;
  password: string;
};

const normalize = (value: unknown) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const text = (value: unknown) => {
  if (value && typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  return String(value ?? "").trim();
};

function value(row: Record<string, string>, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalize));
  return Object.entries(row).find(([header]) => wanted.has(normalize(header)))?.[1]?.trim() ?? "";
}

export async function readNoridianCredentials(file: File): Promise<NoridianCredentials> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Noridian login workbook does not contain a worksheet.");
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => { headers[column] = text(cell.value); });

  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row: Record<string, string> = {};
    headers.forEach((header, column) => { if (header) row[header] = text(sheet.getRow(rowNumber).getCell(column).value); });
    const project = value(row, ["Project", "Project Name"]);
    const portal = value(row, ["Portal", "Portal Name"]);
    if (project && !["medrevenue", "medrevenu", "medrevnu"].includes(normalize(project))) continue;
    if (portal && !["noridian", "noridan"].includes(normalize(portal))) continue;
    const credentials = {
      loginUrl: value(row, ["Link", "URL", "Login URL", "Portal Link"]) || DEFAULT_NORIDIAN_LOGIN_URL,
      username: value(row, ["Username", "User Name", "User ID"]),
      password: value(row, ["Password"]),
    };
    const missing = Object.entries(credentials).filter(([, entry]) => !entry).map(([key]) => key);
    if (missing.length) throw new Error(`MedRevenue Noridian credential row ${rowNumber} is missing: ${missing.join(", ")}.`);
    return { ...credentials, loginUrl: normalizeNoridianLoginUrl(credentials.loginUrl) };
  }
  throw new Error("Missing Noridian login credentials. The login workbook must contain Username and Password columns. Link is optional and defaults to the official Noridian login page.");
}
