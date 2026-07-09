import * as XLSX from "xlsx";
import type {
  EligibilityInputRow,
  EligibilityPayerBatch,
} from "../../types";
import { matchWaystarPayer } from "./payer-registry";

export const INSURANCE_HEADER_ALIASES = [
  "primary insurance name",
  "primary insurance",
  "payer",
  "payer name",
  "insurance name",
  "insurance",
] as const;

export type WaystarWorkbookRouting = {
  payerHeader: string;
  batches: EligibilityPayerBatch[];
  unsupportedRows: Array<{
    rowIndex: number;
    insuranceName: string;
  }>;
  totalRows: number;
};

export async function readWaystarEligibilityWorkbook(
  file: File,
): Promise<WaystarWorkbookRouting> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The eligibility workbook does not contain a worksheet.");

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });
  return routeWaystarRowsByPayer(rows);
}

export function routeWaystarRowsByPayer(
  rows: Record<string, unknown>[],
): WaystarWorkbookRouting {
  if (rows.length === 0) throw new Error("The eligibility workbook is empty.");

  const payerHeader = findInsuranceHeader(Object.keys(rows[0]));
  if (!payerHeader) {
    throw new Error(
      `Missing payer column. Add one of: ${INSURANCE_HEADER_ALIASES.join(", ")}.`,
    );
  }

  const groupedRows = new Map<string, EligibilityPayerBatch>();
  const unsupportedRows: WaystarWorkbookRouting["unsupportedRows"] = [];

  rows.forEach((raw, index) => {
    const rowIndex = index + 2;
    const insuranceName = asText(raw[payerHeader]);
    const payer = matchWaystarPayer(insuranceName);
    if (!payer) {
      unsupportedRows.push({ rowIndex, insuranceName });
      return;
    }

    const eligibilityRow: EligibilityInputRow = {
      originalIndex: rowIndex,
      memberId: findValue(raw, ["member id", "member number", "member no"]),
      subscriberId: findValue(raw, ["subscriber id", "subscriber number", "subscriber no"]),
      patientFirstName: findValue(raw, ["patient first name", "first name"]),
      patientLastName: findValue(raw, ["patient last name", "last name"]),
      dateOfBirth: findValue(raw, ["date of birth", "dob"]),
      dateOfService: findValue(raw, ["date of service", "dos"]),
      serviceType: findValue(raw, ["service type", "service type code"]),
      raw,
    };

    const batch = groupedRows.get(payer.id) ?? {
      payerId: payer.id,
      payerName: payer.name,
      rows: [],
    };
    batch.rows.push(eligibilityRow);
    groupedRows.set(payer.id, batch);
  });

  return {
    payerHeader,
    batches: Array.from(groupedRows.values()),
    unsupportedRows,
    totalRows: rows.length,
  };
}

function findInsuranceHeader(headers: string[]): string | null {
  const aliases = new Set(INSURANCE_HEADER_ALIASES.map(normalizeHeader));
  return headers.find((header) => aliases.has(normalizeHeader(header))) ?? null;
}

function findValue(row: Record<string, unknown>, aliases: string[]): string | undefined {
  const normalizedAliases = new Set(aliases.map(normalizeHeader));
  const key = Object.keys(row).find((header) => normalizedAliases.has(normalizeHeader(header)));
  const value = key ? asText(row[key]) : "";
  return value || undefined;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}
