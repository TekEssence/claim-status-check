import fs from "node:fs/promises";
import path from "node:path";

export type PaymentFilenameDetails = {
  group?: string;
  payer?: string;
  mode?: string;
  amount?: string;
  number?: string;
  date?: string;
};

export function paymentField(row: Record<string, string>, aliases: string[]): string {
  const key = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const wanted = new Set(aliases.map(key));
  return Object.entries(row).find(([name, value]) => wanted.has(key(name)) && value.trim())?.[1].trim() || "";
}

export function paymentMode(row: Record<string, string>): string {
  return paymentField(row, ["Mode of Payment", "Payment Mode", "Payment Method", "Payment Type", "Method", "Type"]);
}

function safe(value: string): string {
  return value.replace(/&#x20;|&nbsp;/gi, " ").replace(/[<>:"/\\|?*\x00-\x1f]/g, "-").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
}

function datePart(value: string, special: boolean): string {
  let year: number, month: number, day: number;
  const iso = value.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T.*)?$/);
  const us = value.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?:\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?)?$/i);
  if (iso) [, year, month, day] = iso.map(Number);
  else if (us) {
    [, month, day, year] = us.map(Number);
    if (year < 100) year += 2000;
  } else return "UnknownDate";
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return "UnknownDate";
  const mm = String(month).padStart(2, "0"), dd = String(day).padStart(2, "0");
  return special ? `${year}${dd}${mm}` : `${mm}-${dd}-${String(year).slice(-2)}`;
}

export function buildPaymentFilename(details: PaymentFilenameDetails, extension = ".pdf"): string {
  const special = ["TAJ", "GEH", "GH"].includes(safe(details.group || "").toUpperCase());
  const payer = safe(details.payer || "") || "UnknownPayer";
  const rawMode = (details.mode || "").trim().toUpperCase();
  const mode = safe(rawMode === "ACH" ? "EFT" : rawMode) || "UnknownMode";
  const rawAmount = (details.amount || "").replace(/[$,\s]/g, "");
  const amount = /^-?\d+(?:\.\d+)?$/.test(rawAmount) ? `$${Number(rawAmount).toFixed(2)}` : "UnknownAmount";
  const date = datePart(details.date || "", special);
  const parts = special ? [payer, mode, amount, safe(details.number || "") || "UnknownNumber", date] : [date, payer, mode, amount];
  const ext = /^\.[a-z0-9]+$/i.test(extension) ? extension : ".pdf";
  return `${parts.join(" ")}${ext}`;
}

// Downloads within each portal are sequential. Check existing files before choosing
// a suffix so distinct payments with the same display fields cannot overwrite.
export async function paymentFilename(folder: string, details: PaymentFilenameDetails, extension = ".pdf"): Promise<string> {
  const name = buildPaymentFilename(details, extension);
  const ext = path.extname(name), stem = name.slice(0, -ext.length);
  let candidate = name;
  for (let index = 2; ; index += 1) {
    try { await fs.access(path.join(folder, candidate)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidate;
      throw error;
    }
    candidate = `${stem} (${index})${ext}`;
  }
}
