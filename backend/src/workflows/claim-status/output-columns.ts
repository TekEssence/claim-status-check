import type ExcelJS from "exceljs";
import { WORKER_OUTCOME_COLUMN, workerOutcomeForOutput } from "./worker-outcome";

export const CLAIM_STATUS_OUTPUT_HEADERS = [
  "Claim Status - Denial Code",
  "Claim Status - Remark Code",
  "Claim Status - Paid Amount",
  "Claim Status - Copay/Coins/Ded",
  "Claim Status - Final Status",
] as const;

type OutputValue = string | number | null;
type OutputRow = Record<string, unknown>;

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && "text" in value) return text((value as { text?: unknown }).text);
  return String(value).trim();
}

function value(value: unknown): OutputValue {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = text(value);
  return normalized && !/^(?:NA|N\/A|null|undefined|[-–—]+)$/i.test(normalized) ? normalized : null;
}

function key(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pick(row: OutputRow, ...aliases: string[]): OutputValue {
  for (const alias of aliases) {
    const found = Object.keys(row).find((name) => key(name) === key(alias));
    if (found) {
      const picked = value(row[found]);
      if (picked !== null) return picked;
    }
  }
  return null;
}

function labeled(source: unknown, label: string): OutputValue {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text(source).match(new RegExp(`(?:^|[|\\n])\\s*${escaped}\\s*:\\s*([^|\\n]+)`, "i"));
  return value(match?.[1]);
}

function phrase(source: unknown, label: string): OutputValue {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text(source).match(new RegExp(`${escaped}(?:\\s+of)?\\s*:?\\s+(\\$?-?[\\d,]+(?:\\.\\d{1,2})?)`, "i"));
  return value(match?.[1]);
}

function amounts(parts: Array<[string, OutputValue]>): OutputValue {
  const present = parts.filter((part): part is [string, string | number] => part[1] !== null);
  return present.length ? present.map(([label, amount]) => `${label}: ${amount}`).join("; ") : null;
}

function iehpCodes(row: OutputRow): { denial: OutputValue; remark: OutputValue } {
  const codes = text(pick(row, "RA Reason")).split(/[,;]\s*/).map((code) => code.trim()).filter(Boolean);
  if (codes.length === 0) return { denial: null, remark: null };
  const remarks = codes.filter((code) => /^(?:MA|M|N)\d+$/i.test(code));
  // Reason descriptions are not adjustment codes. Only copy identifiable codes.
  const denial = codes.filter((code) => /^(?:(?:CO|PR|OA|PI|CR)[ -]?)?\d+$/i.test(code));
  return { denial: value(denial.join(", ")), remark: value(remarks.join(", ")) };
}

function denialCode(portal: string, row: OutputRow): OutputValue {
  switch (portal) {
    case "kaiser": return pick(row, "Claim Codes");
    case "iehp": return iehpCodes(row).denial;
    case "my-family": return labeled(pick(row, "Service Lines"), "Adj Code");
    case "optum-pro": return pick(row, "__denialCode");
    case "availity": return null;
    case "waystar": return value([pick(row, "Denial Code1"), pick(row, "Denial Code 2"), pick(row, "Denial Code 3")]
      .filter((code) => code !== null).join("; "));
    default: return pick(row, "CARC", "denial_code", "BotDenialReasonCode");
  }
}

export function claimStatusOutputValues(portal: string, row: OutputRow): Record<(typeof CLAIM_STATUS_OUTPUT_HEADERS)[number], OutputValue> {
  const serviceLines = pick(row, "Service Lines");
  const details = pick(row, "BotClaimDetails");
  const summary = pick(row, "bot_updated_claim_status");
  const remark = portal === "my-family"
    ? labeled(serviceLines, "Remitt_Code")
    : portal === "iehp"
      ? iehpCodes(row).remark
      : portal === "availity"
        ? pick(row, "RARC", "Remark Codes", "BotRemarkCodes")
    : pick(row, "RARC", "Remark Codes", "BotRemarkCodes");
  const paid = portal === "iehp" ? pick(row, "RA Net Paid") : portal === "my-family"
    ? labeled(serviceLines, "Net Paid")
    : pick(row, "NetPay", "net_amount", "net", "paid", "total_paid", "detail_net_amount", "Bot Amount Paid", "Claim Amount Paid", "Payment Amount", "RA Net Paid", "Net Payable", "PROV PD", "BotPaidAmount", "Paid Amount", "line_pay_amount", "search_pay_amount");
  const copay = portal === "my-family" ? labeled(serviceLines, "Copay") : pick(row, "Copay", "CoPay", "co_pay", "RA Copay", "Bot Copay", "line_copay");
  const coinsurance = portal === "my-family" ? labeled(serviceLines, "Coinsurance") : pick(row, "Coins", "Coinsurance", "co_insure", "RA Coins", "Bot Co-Insurance", "line_coinsurance", "Patient Coinsurance");
  const deductible = portal === "my-family" ? labeled(serviceLines, "Deductible") : pick(row, "Deductible", "RA Deduct Amount", "Bot Deductible", "line_deductible", "DEDUCT");
  const combinedCopayCoinsurance = pick(row, "copay_coinsurance");
  const combinedDeductibleCopay = pick(row, "Deductible/Copay Applied");
  const responsibility = amounts([
    ["Copay", copay ?? (portal === "availity" ? phrase(summary, "copay") : phrase(details, "copay") ?? phrase(details, "co-pay") ?? phrase(details, "copayment"))],
    ["Coinsurance", coinsurance ?? (portal === "availity" ? phrase(summary, "coinsurance") : phrase(details, "coinsurance"))],
    ["Deductible", deductible ?? (portal === "availity" ? phrase(summary, "deductible") : phrase(details, "deductible"))],
    ...(combinedCopayCoinsurance === null ? [] : [["Copay/Coinsurance", combinedCopayCoinsurance] as [string, OutputValue]]),
    ...(combinedDeductibleCopay === null ? [] : [["Deductible/Copay", combinedDeductibleCopay] as [string, OutputValue]]),
  ]);
  const projected = {
    "Claim Status - Denial Code": denialCode(portal, row),
    "Claim Status - Remark Code": remark,
    "Claim Status - Paid Amount": paid ?? (portal === "availity" ? phrase(summary, "paid amount") : null),
    "Claim Status - Copay/Coins/Ded": responsibility,
    "Claim Status - Final Status": pick(row, "final_status", "Final Status", "Final status", "RA Status", "BotClaimResult", "BotClaimStatus", "bot_updated_claim_status", "claim_outcome", "BotStatus", "result", "bot_overall_result"),
  };
  // Existing canonical workbook values take precedence over alias projections.
  for (const header of CLAIM_STATUS_OUTPUT_HEADERS) projected[header] = pick(row, header) ?? projected[header];
  if (/^(?:success|failed|failure|skipped|incomplete|action_required|no_match|not[ _-](?:processed|started|checked)(?:[ .:_-].*)?)$/i.test(text(projected["Claim Status - Final Status"]))) {
    projected["Claim Status - Final Status"] = null;
  }
  // IEHP's check amount covers unrelated claims; RA Net Paid is authoritative.
  if (portal === "iehp") projected["Claim Status - Paid Amount"] = paid ?? pick(row, "Claim Status - Paid Amount");
  return projected;
}

export function claimStatusOutputRows<T extends OutputRow>(portal: string, rows: T[]): Array<T & ReturnType<typeof claimStatusOutputValues>> {
  return rows.map((row) => ({ ...row, ...claimStatusOutputValues(portal, row), [WORKER_OUTCOME_COLUMN]: workerOutcomeForOutput(portal, row) }));
}

export function appendClaimStatusOutputColumns(worksheet: ExcelJS.Worksheet, portal: string): void {
  const headerRow = worksheet.getRow(1);
  const sourceColumns = new Map<string, number>();
  headerRow.eachCell((cell, column) => {
    const label = text(cell.value);
    if (label) sourceColumns.set(label, column);
  });
  const targets = new Map<string, number>();
  const lastSourceColumn = Math.max(1, ...sourceColumns.values());
  let nextColumn = Math.max(worksheet.columnCount, headerRow.cellCount);
  for (const header of [WORKER_OUTCOME_COLUMN, ...CLAIM_STATUS_OUTPUT_HEADERS]) {
    const existingColumn = sourceColumns.get(header);
    const column = existingColumn ?? ++nextColumn;
    const cell = headerRow.getCell(column);
    cell.value = header;
    if (!existingColumn) cell.style = { ...headerRow.getCell(lastSourceColumn).style };
    worksheet.getColumn(column).width = Math.max(25, header.length + 3);
    targets.set(header, column);
  }
  worksheet.eachRow((excelRow, rowNumber) => {
    if (rowNumber === 1) return;
    const source: OutputRow = {};
    for (const [header, column] of sourceColumns) {
      const cell = excelRow.getCell(column);
      source[header] = cell.formula ? cell.result : cell.value;
    }
    // Workbook snapshots must refresh derived columns when native cells change.
    for (const header of CLAIM_STATUS_OUTPUT_HEADERS) delete source[header];
    const projected = claimStatusOutputValues(portal, source);
    for (const header of CLAIM_STATUS_OUTPUT_HEADERS) {
      excelRow.getCell(targets.get(header)!).value = projected[header];
    }
    excelRow.getCell(targets.get(WORKER_OUTCOME_COLUMN)!).value = workerOutcomeForOutput(portal, source);
  });
}

/** A new execution must not inherit completion from an uploaded old workbook. */
export function clearPreviousWorkerOutput(worksheet: ExcelJS.Worksheet): void {
  const columns: number[] = [];
  worksheet.getRow(1).eachCell((cell, column) => {
    const header = String(cell.value ?? "");
    if (/^Bot/i.test(header) || header === WORKER_OUTCOME_COLUMN || CLAIM_STATUS_OUTPUT_HEADERS.some(value => value === header)) columns.push(column);
  });
  worksheet.eachRow((row, index) => {
    if (index > 1) for (const column of columns) row.getCell(column).value = null;
  });
}
