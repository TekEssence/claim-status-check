import * as XLSX from "xlsx";

export function asText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function createUtcDateStrict(year: number, month: number, day: number): Date | null {
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1
  ) {
    return null;
  }

  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() + 1 !== month ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return date;
}

export function parseDateInput(value: unknown): Date | null {
  const isDate = value instanceof Date || (value && typeof value === "object" && Object.prototype.toString.call(value) === "[object Date]");
  if (isDate && !Number.isNaN((value as Date).getTime())) {
    const d = value as Date;
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }

  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) return null;
    return createUtcDateStrict(parsed.y, parsed.m, parsed.d);
  }

  const dateValue = asText(value);
  if (!dateValue) return null;

  const isoMatch = dateValue.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) {
    return createUtcDateStrict(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  const parts = dateValue.split("/");
  if (parts.length !== 3) return null;

  const a = Number(parts[0]);
  const b = Number(parts[1]);
  const year = Number(parts[2].length === 2 ? `20${parts[2]}` : parts[2]);

  let month: number;
  let day: number;
  if (a > 12) {
    day = a;
    month = b;
  } else if (b > 12) {
    month = a;
    day = b;
  } else {
    month = a;
    day = b;
  }

  return createUtcDateStrict(year, month, day);
}

export function formatMmDdYyyy(date: Date): string {
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const y = String(date.getUTCFullYear());
  return `${m}/${d}/${y}`;
}

export function getDosSearchRange(dosDate: Date) {
  const startDate = new Date(dosDate);
  startDate.setUTCDate(dosDate.getUTCDate() - 1);

  const endDate = new Date(dosDate);
  endDate.setUTCDate(dosDate.getUTCDate() + 1);

  return {
    startDate,
    endDate,
    formattedDos: formatMmDdYyyy(dosDate),
    formattedStart: formatMmDdYyyy(startDate),
    formattedEnd: formatMmDdYyyy(endDate),
  };
}

export function parseWebsiteMmDdYyyy(value: string): Date | null {
  const match = value.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;

  return new Date(Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2])));
}

export function getPrimaryDosColumnIndex(headers: string[]): number {
  const index = headers.findIndex((header) => {
    const text = header.trim().toLowerCase();
    return text.includes("primary dos") || text.includes("primary date");
  });

  return index === -1 ? -1 : index + 1;
}

export function getReceivedColumnIndex(headers: string[]): number {
  const index = headers.findIndex((header) => {
    const text = header.replace(/\s+/g, " ").trim().toLowerCase();
    return text === "received" || text.includes("received date");
  });

  return index === -1 ? -1 : index + 1;
}

export function exactMmDdYyyyPattern(value: string): RegExp {
  return new RegExp(`^\\s*${value.replace(/\//g, "\\/")}\\s*$`);
}
