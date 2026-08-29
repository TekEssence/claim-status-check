import ExcelJS from "exceljs";
import { readWaystarCredentials } from "../../../eligibility-verification/portals/waystar/credentials";
import type { WaystarControlLogRow, WaystarPaymentCredentials } from "./types";

const DEFAULT_LOGIN_URL = "https://login.zirmed.com/ui";

function text(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  if (typeof value === "object" && "result" in value) return text((value as { result?: unknown }).result);
  return String(value).trim();
}

function key(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }

function find(row: Record<string, unknown>, aliases: string[]): string {
  const keys = new Set(aliases.map(key));
  for (const [header, value] of Object.entries(row)) if (keys.has(key(header))) return text(value);
  return "";
}

async function rows(file: File, sheetNames?: string[]): Promise<{ headers: string[]; rows: Record<string, unknown>[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await file.arrayBuffer());
  const wantedSheets = sheetNames?.map(key);
  const sheet = wantedSheets?.length
    ? workbook.worksheets.find((candidate) => wantedSheets.includes(key(candidate.name)))
    : workbook.worksheets[0];
  if (!sheet) throw new Error(`${file.name || "Workbook"} does not contain a worksheet.`);
  const headers: string[] = [];
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => { headers[column] = text(cell.value); });
  const result: Record<string, unknown>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const value: Record<string, unknown> = {};
    headers.forEach((header, column) => { if (header) value[header] = row.getCell(column).value; });
    if (Object.values(value).some((entry) => text(entry))) result.push(value);
  });
  return { headers: headers.filter(Boolean), rows: result };
}

export async function readWaystarPaymentCredentials(file: File): Promise<WaystarPaymentCredentials> {
  const base = await readWaystarCredentials(file);
  const workbookRows = await rows(file);
  const matching = workbookRows.rows.find((row) => find(row, ["Username", "User Name", "Login Name"]) === base.username) ?? workbookRows.rows[0];
  const clientName = matching ? find(matching, ["Client Name", "Client"]) : "";
  if (!clientName) throw new Error("Waystar credential Excel must contain a Client Name column.");
  const rawLookbackDays = matching ? find(matching, ["Lookback Days", "Look Back Days", "Days Back", "Zero Payment Lookback Days"]) : "";
  const parsedLookbackDays = Number.parseInt(rawLookbackDays.replace(/[^\d]/g, ""), 10);
  const lookbackDays = Number.isFinite(parsedLookbackDays) && parsedLookbackDays > 0 ? parsedLookbackDays : 7;
  const questionRows = await rows(file, ["Questions", "Verification"]).catch(() => ({ headers: [], rows: [] }));
  const paymentAnswers = questionRows.rows.map((row) => ({
    username: find(row, ["Username", "User Name", "Login Name"]) || undefined,
    question: find(row, ["Question", "Security Question", "Verification Question"]),
    answer: find(row, ["Answer", "Security Answer", "Verification Answer"]),
  })).filter((entry) => entry.question && entry.answer && (!entry.username || key(entry.username) === key(base.username)));
  return {
    ...base,
    loginUrl: base.loginUrl.includes("waystar.com") && !base.loginUrl.includes("zirmed.com") ? DEFAULT_LOGIN_URL : base.loginUrl,
    verificationAnswers: paymentAnswers.length ? paymentAnswers : base.verificationAnswers,
    clientName,
    account: clientName,
    lookbackDays,
  };
}

export async function readWaystarControlLog(file: File): Promise<{ headers: string[]; rows: WaystarControlLogRow[] }> {
  const parsed = await rows(file);
  const controlRows = parsed.rows.map((values, index) => ({
    rowNumber: index + 2,
    values,
    clientName: find(values, ["Client Name", "Client"]),
    checkNumber: find(values, [
      "Check number",
      "Check Number",
      "Check #",
      "Payment #",
      "Check/EFT Number",
      "Check / EFT Number",
      "Check / EFT Trace #",
      "Check/EFT Trace #",
      "Check EFT Trace #",
      "EFT Trace Number",
      "Check/EFT/Trace Number",
    ]),
    batchTotalAmount: find(values, ["Batch Total Amount", "Batch Amount", "Total Amount"]),
    entryStatus: find(values, ["Entry Status", "Status"]),
    source: find(values, ["Source", "Payment Source", "Portal Source"]),
  }));
  if (!controlRows.length) throw new Error("Control Log does not contain any data rows.");
  if (!controlRows.some((row) => isEligibleWaystarControlRow(row))) {
    throw new Error("Control Log has no rows where Entry Status is In Progress/In-Process and Source is Waystar.");
  }
  return { headers: parsed.headers, rows: controlRows };
}

export const normalizePaymentNumber = (value: unknown) => text(value).replace(/\.0$/, "").replace(/\s+/g, "").toUpperCase();
export function isUsableCheckNumber(value: unknown): boolean {
  const normalized = normalizePaymentNumber(value).replace(/[^A-Z0-9]/g, "");
  return Boolean(normalized && !["NA", "NONE", "NULL", "NIL"].includes(normalized));
}

export function isInProgressStatus(value: unknown): boolean {
  const normalized = key(text(value));
  return normalized === "inprogress" || normalized === "inprocess";
}

export function isWaystarSource(value: unknown): boolean {
  return key(text(value)) === "waystar";
}

export function isEligibleWaystarControlRow(row: Pick<WaystarControlLogRow, "entryStatus" | "source">): boolean {
  return isInProgressStatus(row.entryStatus) && isWaystarSource(row.source);
}

export function normalizeAmount(value: unknown): number | null {
  const normalized = text(value).replace(/[,$\s()]/g, (token) => token === "(" ? "-" : "");
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}
