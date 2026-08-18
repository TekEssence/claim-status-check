import type ExcelJS from "exceljs";

export type UhcClaimRow = {
  rowIndex: number;
  subscriberNo: string;
  patientDOB: string;
  serviceDate: string;
  patientName?: string;
  patientFirstName?: string;
  patientLastName?: string;
  [key: string]: unknown;
};

const BOT_HEADERS = [
  "BotClaimNumber",
  "BotClaimStatus",
  "BotPaidAmount",
  "BotBilledAmount",
  "BotCheckEFTNumber",
  "BotDenialReasonCode",
  "BotDenialDescription",
  "BotRemarkCodes",
  "BotProcessedDate",
  "BotClaimDetails",
  "BotClaimResult",
  "BotUpdateTime",
  "BotStatus",
  "BotStatusError",
] as const;

const MONEY_BOT_HEADERS = new Set<string>(["BotPaidAmount", "BotBilledAmount"]);

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) {
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${month}/${day}/${value.getUTCFullYear()}`;
  }
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value).trim();
}

function parseMoneyValue(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = cellText(value);
  if (!text) return null;
  const hasMoneyMarker = text.includes("$") || /\d/.test(text);
  if (!hasMoneyMarker) return null;
  const isAccountingNegative = text.includes("(") && text.includes(")");
  const isLeadingNegative = text.trim().startsWith("-");
  const amount = Number.parseFloat(text.replace(/[^0-9.]/g, ""));
  if (!Number.isFinite(amount)) return null;
  return isAccountingNegative || isLeadingNegative ? -amount : amount;
}

function normalizeDateValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "";
  if (value instanceof Date) {
    const month = String(value.getUTCMonth() + 1).padStart(2, "0");
    const day = String(value.getUTCDate()).padStart(2, "0");
    return `${month}/${day}/${value.getUTCFullYear()}`;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30);
    const date = new Date(epoch + value * 24 * 60 * 60 * 1000);
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    return `${month}/${day}/${date.getUTCFullYear()}`;
  }
  if (typeof value === "object" && "text" in value) {
    return normalizeDateValue((value as { text?: unknown }).text);
  }
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function findColumn(headerRow: ExcelJS.Row, aliases: string[]): number {
  const normalizedAliases = aliases.map(normalizeHeader);
  let found = 0;
  headerRow.eachCell((cell, colNum) => {
    if (found) return;
    const normalized = normalizeHeader(cellText(cell.value));
    if (normalizedAliases.some((alias) => normalized === alias || normalized.includes(alias))) {
      found = colNum;
    }
  });
  return found;
}

function ensureBotHeaders(worksheet: ExcelJS.Worksheet): Map<string, number> {
  const headerRow = worksheet.getRow(1);
  const headerMap = new Map<string, number>();
  headerRow.eachCell((cell, colNum) => {
    const label = cellText(cell.value);
    if (label) headerMap.set(label, colNum);
  });

  let nextCol = headerRow.cellCount + 1;
  for (const label of BOT_HEADERS) {
    if (!headerMap.has(label)) {
      headerRow.getCell(nextCol).value = label;
      headerMap.set(label, nextCol);
      nextCol += 1;
    }
  }
  headerRow.commit();
  return headerMap;
}

export function parseUhcClaimRows(
  worksheet: ExcelJS.Worksheet,
  options: { requirePatientDob?: boolean } = {},
): UhcClaimRow[] {
  const headerRow = worksheet.getRow(1);
  const subscriberCol = findColumn(headerRow, [
    "subscriber no",
    "subscriber number",
    "subscriber id",
    "subscriberid",
    "subscriber",
    "member id",
    "memberid",
    "member no",
    "member number",
    "uhc id",
    "policy id",
    "policy number",
  ]);
  const dobCol = findColumn(headerRow, [
    "patient dob",
    "patient date of birth",
    "patient birth date",
    "member dob",
    "member date of birth",
    "subscriber dob",
    "subscriber date of birth",
    "dob",
    "date of birth",
    "birth date",
    "birth",
  ]);
  const serviceDateCol = findColumn(headerRow, [
    "service date",
    "date of service",
    "dos",
    "dos from",
    "from dos",
    "service from date",
    "service start date",
    "first service date",
    "claim service date",
  ]);
  const patientCol = findColumn(headerRow, ["patient", "patient name", "member name", "subscriber name", "name"]);
  const firstNameCol = findColumn(headerRow, ["first name", "patient first name", "member first name", "subscriber first name"]);
  const lastNameCol = findColumn(headerRow, ["last name", "patient last name", "member last name", "subscriber last name"]);

  if (!subscriberCol || !serviceDateCol) {
    throw new Error(
      options.requirePatientDob
        ? 'Missing required columns. Minimax UHC requires subscriber/member id and service date columns.'
        : 'Missing required columns. MedRevenu UHC requires subscriber/member id and service date columns.',
    );
  }

  const rows: UhcClaimRow[] = [];
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const subscriberNo = cellText(row.getCell(subscriberCol).value);
    if (!subscriberNo) return;
    const source: UhcClaimRow = {
      rowIndex: rowNumber,
      subscriberNo,
      patientDOB: dobCol ? normalizeDateValue(row.getCell(dobCol).value) : "",
      serviceDate: normalizeDateValue(row.getCell(serviceDateCol).value),
      patientName: patientCol ? cellText(row.getCell(patientCol).value) : "",
      patientFirstName: firstNameCol ? cellText(row.getCell(firstNameCol).value) : "",
      patientLastName: lastNameCol ? cellText(row.getCell(lastNameCol).value) : "",
    };

    headerRow.eachCell((cell, colNum) => {
      const label = cellText(cell.value);
      if (label && !(label in source)) {
        source[label] = cellText(row.getCell(colNum).value);
      }
    });

    rows.push(source);
  });
  return rows;
}

export function applyUhcRowUpdateToWorksheet(
  worksheet: ExcelJS.Worksheet,
  eventData: { rowIndex?: number; index?: number; update?: Record<string, unknown> },
): void {
  const headerMap = ensureBotHeaders(worksheet);
  const rowIndex = eventData.rowIndex || (typeof eventData.index === "number" ? eventData.index + 2 : 0);
  if (!rowIndex) return;

  const row = worksheet.getRow(rowIndex);
  for (const [key, value] of Object.entries(eventData.update ?? {})) {
    const colNum = headerMap.get(key);
    if (colNum) {
      const cell = row.getCell(colNum);
      if (MONEY_BOT_HEADERS.has(key)) {
        const moneyValue = parseMoneyValue(value);
        if (moneyValue !== null) {
          cell.value = moneyValue;
          cell.numFmt = '$#,##0.00;-$#,##0.00';
        } else {
          cell.value = value === undefined || value === null ? "" : String(value);
        }
      } else {
        cell.value = value === undefined || value === null ? "" : String(value);
      }
    }
  }
  row.commit();
}

export function postProcessUhcWorksheet(worksheet: ExcelJS.Worksheet): void {
  const headerRow = worksheet.getRow(1);
  const subscriberCol = findColumn(headerRow, [
    "subscriber no",
    "subscriber number",
    "subscriber id",
    "subscriberid",
    "subscriber",
    "member id",
    "memberid",
    "member no",
    "member number",
    "uhc id",
    "policy id",
    "policy number",
  ]);
  const serviceDateCol = findColumn(headerRow, [
    "service date",
    "date of service",
    "dos",
    "dos from",
    "from dos",
    "service from date",
    "service start date",
    "first service date",
    "claim service date",
  ]);
  const botColumns: number[] = [];

  headerRow.eachCell((cell, colNum) => {
    if (cellText(cell.value).startsWith("Bot")) botColumns.push(colNum);
  });

  if (!subscriberCol || !serviceDateCol || botColumns.length === 0) return;

  const groups = new Map<string, number[]>();
  worksheet.eachRow((row, rowNum) => {
    if (rowNum === 1) return;
    const subscriberNo = cellText(row.getCell(subscriberCol).value);
    const serviceDate = cellText(row.getCell(serviceDateCol).value);
    if (!subscriberNo) return;
    const key = `${subscriberNo}|${serviceDate}`;
    groups.set(key, [...(groups.get(key) ?? []), rowNum]);
  });

  for (const rowNums of groups.values()) {
    if (rowNums.length < 2) continue;
    const sourceRow = worksheet.getRow(rowNums[0]);
    for (const rowNum of rowNums.slice(1)) {
      const targetRow = worksheet.getRow(rowNum);
      for (const colNum of botColumns) {
        targetRow.getCell(colNum).value = sourceRow.getCell(colNum).value;
      }
      targetRow.commit();
    }
  }
}
