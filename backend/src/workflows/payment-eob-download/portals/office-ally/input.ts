import * as XLSX from "xlsx";

export type OfficeAllyCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  dates: string[];
};

export function parseReportDate(value: unknown, label: string): Date {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  const match = String(value ?? "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) throw new Error(`${label} is required in MM/DD/YYYY format.`);
  const [, month, day, year] = match.map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 1900 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${label} is not a valid calendar date.`);
  }
  return date;
}

export function reportDates(startValue: unknown, endValue: unknown): string[] {
  const start = parseReportDate(startValue, "Start Date");
  const end = parseReportDate(endValue, "End Date");
  if (end < start) throw new Error("End Date must be on or after Start Date.");
  const dates: string[] = [];
  for (let time = start.getTime(); time <= end.getTime(); time += 86400000) {
    const date = new Date(time);
    dates.push(`${date.getUTCMonth() + 1}/${date.getUTCDate()}/${date.getUTCFullYear()}`);
  }
  return dates;
}

export async function readOfficeAllyCredentials(file: File): Promise<OfficeAllyCredentials> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array", cellDates: true, raw: true });
  const required = ["Login URL", "Username", "Password", "Start Date", "End Date"];
  const normalize = (value: unknown) => String(value ?? "").trim().toLowerCase();
  const accounts: OfficeAllyCredentials[] = [];
  for (const name of workbook.SheetNames) {
    const grid = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], { header: 1, defval: "", raw: true });
    const headerIndex = grid.findIndex(row => required.every(header => row.some(cell => normalize(cell) === normalize(header))));
    if (headerIndex < 0) continue;
    const columns = required.map(header => grid[headerIndex].findIndex(cell => normalize(cell) === normalize(header)));
    for (const row of grid.slice(headerIndex + 1)) {
      const values = columns.map(column => row[column]);
      if (values.every(value => value == null || value === "")) continue;
      const [url, user, password, start, end] = values;
      if (!url || !user || !password) throw new Error("Office Ally requires Login URL, Username, and Password in every credential row.");
      const loginUrl = String(url).trim();
      const parsed = new URL(loginUrl);
      if (parsed.protocol !== "https:" || !(parsed.hostname === "officeally.com" || parsed.hostname.endsWith(".officeally.com")) || parsed.username || parsed.password) {
        throw new Error("Login URL must be an HTTPS Office Ally URL.");
      }
      accounts.push({ loginUrl, username: String(user).trim(), password: String(password), dates: reportDates(start, end) });
    }
  }
  if (accounts.length !== 1) throw new Error("Provide exactly one Office Ally credential row with Login URL, Username, Password, Start Date, and End Date.");
  return accounts[0];
}
