import * as XLSX from "xlsx";

export type AvailityEligibilityPayerId =
  | "aetna-medicare"
  | "bcbs"
  | "van-lang-ipa"
  | "amerigroup"
  | "wellpoint"
  | "wellcare";

export const AVAILITY_ORIGINAL_ROW_FIELD = "__AvailityOriginalRow";

export type AvailityEligibilityPayerBatch = {
  payerId: AvailityEligibilityPayerId;
  inputFile: File;
  rowCount: number;
  originalRowNumbers: number[];
};

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
  if (normalized.includes("aetna") && normalized.includes("medicare")) return "aetna-medicare";
  if (
    normalized === "bcbs"
    || normalized.includes("bcbstx")
    || normalized.includes("bluecross")
    || normalized.includes("blueshield")
  ) return "bcbs";
  if (normalized.includes("vanlang")) return "van-lang-ipa";
  if (normalized.includes("amerigroup")) return "amerigroup";
  if (normalized.includes("wellcare")) return "wellcare";
  if (normalized.includes("wellpoint")) return "wellpoint";
  throw new Error(
    `Unsupported Availity eligibility payer "${payerName}" in the input workbook. Expected Aetna Medicare, Blue Cross Blue Shield, Van Lang IPA, Amerigroup, Wellpoint, or Wellcare.`,
  );
}

export async function readAvailityEligibilityInputPayers(
  inputFile: File,
): Promise<AvailityEligibilityPayerBatch[]> {
  const workbook = XLSX.read(await inputFile.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The Availity eligibility input workbook does not contain a worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("The Availity eligibility input workbook is empty.");

  const grouped = new Map<AvailityEligibilityPayerId, Record<string, unknown>[]>();
  for (const [index, row] of rows.entries()) {
    const payerName = findPayerName(row);
    if (!payerName) {
      throw new Error(
        `Missing payer name in row ${index + 2}. Add one of these columns: ${PAYER_HEADERS.join(", ")}.`,
      );
    }
    const payerId = resolveAvailityEligibilityInputPayer(payerName);
    const payerRows = grouped.get(payerId) ?? [];
    payerRows.push({ ...row, [AVAILITY_ORIGINAL_ROW_FIELD]: index + 2 });
    grouped.set(payerId, payerRows);
  }

  return Array.from(grouped, ([payerId, payerRows]) => {
    const payerWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      payerWorkbook,
      XLSX.utils.json_to_sheet(payerRows),
      workbook.SheetNames[0] || "Eligibility",
    );
    const buffer = XLSX.write(payerWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(buffer);
    return {
      payerId,
      rowCount: payerRows.length,
      originalRowNumbers: payerRows.map((row) => Number(row[AVAILITY_ORIGINAL_ROW_FIELD])),
      inputFile: new File([bytes], `${payerId}-${inputFile.name}`, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    };
  });
}

export async function readAvailityEligibilityInputPayer(
  inputFile: File,
): Promise<AvailityEligibilityPayerId> {
  const batches = await readAvailityEligibilityInputPayers(inputFile);
  if (batches.length !== 1) {
    throw new Error("The Availity eligibility input workbook contains multiple payers.");
  }
  return batches[0].payerId;
}
