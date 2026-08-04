import * as XLSX from "xlsx";

export type AvailityEligibilityPayerId = "bcbs" | "van-lang-ipa";

function normalize(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeKey(value: unknown): string {
  return normalize(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const PAYER_HEADERS = [
  "Payer",
  "Payer Name",
  "Insurance",
  "Insurance Name",
  "Primary Insurance",
  "Primary Insurance Name",
  "Primary Insurance Payer",
  "Primary Insurance Payer Name",
  "Primary Insurance Payer State",
];

function findPayerName(row: Record<string, unknown>): string {
  const wanted = new Set(PAYER_HEADERS.map(normalizeKey));
  const match = Object.entries(row).find(([header]) => wanted.has(normalizeKey(header)));
  return normalize(match?.[1]);
}

export function resolveAvailityEligibilityInputPayer(payerName: string): AvailityEligibilityPayerId {
  const normalized = normalizeKey(payerName);
  if (
    normalized === "bcbs"
    || normalized.includes("bcbstx")
    || normalized.includes("bluecross")
    || normalized.includes("blueshield")
  ) return "bcbs";
  if (normalized.includes("vanlang")) return "van-lang-ipa";
  throw new Error(
    `Unsupported Availity eligibility payer "${payerName}" in the input workbook. Expected Blue Cross Blue Shield or Van Lang IPA.`,
  );
}

export async function readAvailityEligibilityInputPayer(
  inputFile: File,
): Promise<AvailityEligibilityPayerId> {
  const workbook = XLSX.read(await inputFile.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The Availity eligibility input workbook does not contain a worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("The Availity eligibility input workbook is empty.");

  const payerNames = rows.map(findPayerName).filter(Boolean);
  if (!payerNames.length) {
    throw new Error(
      `Missing payer name in the Availity eligibility input workbook. Add one of these columns: ${PAYER_HEADERS.join(", ")}.`,
    );
  }

  const payerIds = new Set(payerNames.map(resolveAvailityEligibilityInputPayer));
  if (payerIds.size > 1) {
    throw new Error("The Availity eligibility input workbook contains both BCBS and Van Lang IPA rows. Upload one payer per run.");
  }
  return [...payerIds][0];
}