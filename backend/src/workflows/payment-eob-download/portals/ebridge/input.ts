import ExcelJS from "exceljs";

const DEFAULT_LOGIN_URL = "https://www.ebridge.com/";

export type EbridgeCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  fileCabinet: string;
  clientName?: string;
  startDate: string;
  endDate: string;
};

function text(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return `${value.getUTCMonth() + 1}/${value.getUTCDate()}/${value.getUTCFullYear()}`;
  if (typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  if (typeof value === "object" && "result" in value) return text((value as { result?: unknown }).result);
  return String(value).trim();
}

function key(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueFor(row: Record<string, string>, aliases: string[]): string {
  const wanted = new Set(aliases.map(key));
  return Object.entries(row).find(([header, value]) => wanted.has(key(header)) && value.trim())?.[1].trim() ?? "";
}

function normalizeDate(value: unknown, label: string): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return `${String(value.getUTCMonth() + 1).padStart(2, "0")}/${String(value.getUTCDate()).padStart(2, "0")}/${value.getUTCFullYear()}`;
  }
  const raw = text(value);
  const match = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!match) throw new Error(`eBridge ${label} is required in MM/DD/YYYY format.`);
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    throw new Error(`eBridge ${label} is not a valid calendar date.`);
  }
  return `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}/${year}`;
}

async function workbookRows(file: File): Promise<Record<string, string>[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const rows: Record<string, string>[] = [];
  for (const sheet of workbook.worksheets) {
    let headerRow = 0;
    const headers: string[] = [];
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (headerRow) return;
      const values = row.values as unknown[];
      if (values.some((value) => /login|user|password|file\s*cabinet|start\s*date|end\s*date/i.test(text(value)))) {
        headerRow = rowNumber;
        row.eachCell({ includeEmpty: true }, (cell, column) => { headers[column] = text(cell.value); });
      }
    });
    if (!headerRow) continue;
    sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
      if (rowNumber <= headerRow) return;
      const data: Record<string, string> = {};
      headers.forEach((header, column) => { if (header) data[header] = text(row.getCell(column).value); });
      if (Object.values(data).some(Boolean)) rows.push(data);
    });
  }
  return rows;
}

export async function readEbridgeCredentials(file: File): Promise<EbridgeCredentials> {
  const rows = await workbookRows(file);
  for (const row of rows) {
    const username = valueFor(row, ["Username", "User Name", "Login", "Login ID"]);
    const password = valueFor(row, ["Password"]);
    const fileCabinet = valueFor(row, ["File Cabinet", "Cabinet"]);
    if (!username || !password || !fileCabinet) continue;
    const rawUrl = valueFor(row, ["Login URL", "URL", "Link", "Portal Link"]);
    const loginUrl = rawUrl ? (rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`) : DEFAULT_LOGIN_URL;
    const parsedUrl = new URL(loginUrl);
    if (parsedUrl.protocol !== "https:" || !(parsedUrl.hostname === "ebridge.com" || parsedUrl.hostname.endsWith(".ebridge.com"))) {
      throw new Error("eBridge Login URL must be an HTTPS ebridge.com URL.");
    }
    return {
      loginUrl,
      username,
      password,
      fileCabinet,
      clientName: valueFor(row, ["Client Name", "Client", "Group", "Group Name"]),
      startDate: normalizeDate(valueFor(row, ["Start Date", "From Date"]), "Start Date"),
      endDate: normalizeDate(valueFor(row, ["End Date", "To Date"]), "End Date"),
    };
  }
  throw new Error("Missing eBridge credentials. Credential Excel must contain Username, Password, File Cabinet, Start Date, and End Date.");
}
