import * as XLSX from "xlsx";
import type {
  EligibilityInputRow,
  EligibilityPayerBatch,
} from "../../types";
import {
  matchWaystarPayer,
  matchWaystarPayerByPortalName,
} from "./payer-registry";
import type { WaystarPayerHandler } from "./payers/types";

export const INSURANCE_HEADER_ALIASES = [
  "primary insurance name",
  "primary insurance",
  "primary insurance payer",
  "primary insurance payer state",
  "payer",
  "payer name",
  "payer state",
  "insurance name",
  "insurance payer",
  "insurance payer state",
  "insurance",
  "primary ins subscriber no",
] as const;

export const BCBS_PAYER_MAPPINGS_SHEET = "BCBS_Payer_Mappings";

export type WaystarPayerPortalMapping = {
  inputInsurancePayerState: string;
  payerPortal: string;
};

export type WaystarWorkbookRouting = {
  payerHeader: string;
  batches: EligibilityPayerBatch[];
  unsupportedRows: Array<{
    rowIndex: number;
    insuranceName: string;
  }>;
  totalRows: number;
};

export type WaystarRoutingOptions = {
  payerMappings?: WaystarPayerPortalMapping[];
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
  return routeWaystarRowsByPayer(rows, {
    payerMappings: readBcbsPayerMappings(workbook),
  });
}

export function routeWaystarRowsByPayer(
  rows: Record<string, unknown>[],
  options: WaystarRoutingOptions = {},
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
    const payer = resolveWaystarPayer(insuranceName, options.payerMappings);
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

function readBcbsPayerMappings(workbook: XLSX.WorkBook): WaystarPayerPortalMapping[] {
  const sheetName = workbook.SheetNames.find(
    (name) => normalizeHeader(name) === normalizeHeader(BCBS_PAYER_MAPPINGS_SHEET),
  );
  const sheet = sheetName ? workbook.Sheets[sheetName] : null;
  if (!sheet) return [];

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
  });

  return rows
    .map((row) => ({
      inputInsurancePayerState: findValue(row, ["input insurance payer state"]) ?? "",
      payerPortal: findValue(row, ["payer portal"]) ?? "",
    }))
    .filter((mapping) => mapping.inputInsurancePayerState && mapping.payerPortal);
}

function resolveWaystarPayer(
  insuranceName: string,
  payerMappings: WaystarPayerPortalMapping[] = [],
): WaystarPayerHandler | null {
  const normalizedInsuranceName = normalizeHeader(insuranceName);
  const mapping = payerMappings.find(
    (entry) => normalizeHeader(entry.inputInsurancePayerState) === normalizedInsuranceName,
  );
  if (mapping) {
    return matchWaystarPayerByPortalName(mapping.payerPortal);
  }

  return matchWaystarPayer(insuranceName);
}

function findInsuranceHeader(headers: string[]): string | null {
  const aliases = new Set(INSURANCE_HEADER_ALIASES.map(normalizeHeader));
  return headers.find((header) => aliases.has(normalizeHeader(header))) ??
    headers.find(isLikelyInsuranceHeader) ??
    null;
}

function isLikelyInsuranceHeader(header: string): boolean {
  const normalized = normalizeHeader(header);
  const tokens = new Set(normalized.split(" ").filter(Boolean));
  const hasPayerOrInsurance = tokens.has("payer") || tokens.has("insurance");
  const hasNameOrState = tokens.has("name") || tokens.has("state") || tokens.has("plan");
  return hasPayerOrInsurance && hasNameOrState;
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
