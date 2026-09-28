import * as XLSX from "xlsx";

export type AvailityEligibilityPayerId =
  | "aetna-medicare"
  | "bcbs"
  | "humana"
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

export type AvailityEligibilitySkippedRow = {
  rowNumber: number;
  payerName: string;
  error: string;
};

export type AvailityEligibilityInputRouting = {
  batches: AvailityEligibilityPayerBatch[];
  skippedRows: AvailityEligibilitySkippedRow[];
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
  if (normalized.includes("aetna")) return "aetna-medicare";
  if (
    normalized === "bcbs"
    || normalized.includes("bcbstx")
    || normalized.includes("bluecross")
    || normalized.includes("blueshield")
  ) return "bcbs";
  if (normalized.includes("humana")) return "humana";
  if (normalized.includes("vicarehealthipa")) return "van-lang-ipa";
  if (normalized.includes("vanlang")) return "van-lang-ipa";
  if (normalized.includes("amerigroup")) return "amerigroup";
  if (normalized.includes("wellcare")) return "wellcare";
  if (normalized.includes("wellpoint")) return "wellpoint";
  throw new Error(unsupportedPayerError(payerName));
}

function unsupportedPayerError(payerName: string): string {
  return `Unsupported Availity eligibility payer "${payerName}" in the input workbook. Expected Aetna, Aetna Medicare, Blue Cross Blue Shield, Humana, Van Lang IPA, VI Care Health IPA, Amerigroup, Wellpoint, or Wellcare.`;
}

function createPayerBatches(
  grouped: Map<AvailityEligibilityPayerId, Record<string, unknown>[]>,
  sheetName: string,
  inputFileName: string,
): AvailityEligibilityPayerBatch[] {
  return Array.from(grouped, ([payerId, payerRows]) => {
    const payerWorkbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      payerWorkbook,
      XLSX.utils.json_to_sheet(payerRows),
      sheetName || "Eligibility",
    );
    const buffer = XLSX.write(payerWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const bytes = new Uint8Array(buffer.byteLength);
    bytes.set(buffer);
    return {
      payerId,
      rowCount: payerRows.length,
      originalRowNumbers: payerRows.map((row) => Number(row[AVAILITY_ORIGINAL_ROW_FIELD])),
      inputFile: new File([bytes], `${payerId}-${inputFileName}`, {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      }),
    };
  });
}

export async function readAvailityEligibilityInputRouting(
  inputFile: File,
): Promise<AvailityEligibilityInputRouting> {
  const workbook = XLSX.read(await inputFile.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The Availity eligibility input workbook does not contain a worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("The Availity eligibility input workbook is empty.");

  const grouped = new Map<AvailityEligibilityPayerId, Record<string, unknown>[]>();
  const skippedRows: AvailityEligibilitySkippedRow[] = [];
  for (const [index, row] of rows.entries()) {
    const rowNumber = index + 2;
    const payerName = findPayerName(row);
    if (!payerName) {
      skippedRows.push({
        rowNumber,
        payerName: "",
        error: `Missing payer name in row ${rowNumber}. Add one of these columns: ${PAYER_HEADERS.join(", ")}.`,
      });
      continue;
    }
    let payerId: AvailityEligibilityPayerId;
    try {
      payerId = resolveAvailityEligibilityInputPayer(payerName);
    } catch {
      skippedRows.push({
        rowNumber,
        payerName,
        error: unsupportedPayerError(payerName),
      });
      continue;
    }
    const payerRows = grouped.get(payerId) ?? [];
    payerRows.push({ ...row, [AVAILITY_ORIGINAL_ROW_FIELD]: rowNumber });
    grouped.set(payerId, payerRows);
  }

  return {
    batches: createPayerBatches(grouped, workbook.SheetNames[0], inputFile.name),
    skippedRows,
  };
}

export async function readAvailityEligibilityInputPayers(
  inputFile: File,
): Promise<AvailityEligibilityPayerBatch[]> {
  return (await readAvailityEligibilityInputRouting(inputFile)).batches;
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
