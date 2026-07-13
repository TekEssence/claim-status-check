import ExcelJS from "exceljs";
import type { BlueShieldAuditRow, BlueShieldErrorRow, BlueShieldOutputRow } from "./types";

export type BlueShieldWorkbookState = {
  outputRows: BlueShieldOutputRow[];
  errorRows: BlueShieldErrorRow[];
  auditRows: BlueShieldAuditRow[];
};

export function createBlueShieldWorkbookState(): BlueShieldWorkbookState {
  return { outputRows: [], errorRows: [], auditRows: [] };
}

type ColumnDef<T> = {
  key: keyof T;
  header: string;
  width: number;
};

const outputColumns: Array<ColumnDef<Omit<BlueShieldOutputRow, "inputData">>> = [
  { key: "inputRowId", header: "Input Row", width: 12 },
  { key: "botStatus", header: "Bot Status", width: 16 },
  { key: "botMessage", header: "Bot Message", width: 36 },
  { key: "botPlanType", header: "Bot Plan Type", width: 22 },
  { key: "botClaimNumber", header: "Bot Claim Number", width: 18 },
  { key: "botClaimStatus", header: "Bot Claim Status", width: 16 },
  { key: "botProcedureCode", header: "Bot Procedure Code", width: 18 },
  { key: "botModifier", header: "Bot Modifier", width: 14 },
  { key: "botServiceLineNumber", header: "Bot Line #", width: 12 },
  { key: "botServiceLineDatesOfService", header: "Bot Line Dates of Service", width: 24 },
  { key: "botAmountBilled", header: "Bot Amount Billed", width: 18 },
  { key: "botAllowedAmount", header: "Bot Allowed Amount", width: 18 },
  { key: "botDeductible", header: "Bot Deductible", width: 16 },
  { key: "botCopay", header: "Bot Copay", width: 14 },
  { key: "botCoInsurance", header: "Bot Co-Insurance", width: 18 },
  { key: "botAmountPaid", header: "Bot Amount Paid", width: 16 },
  { key: "botClaimNotes", header: "Bot Claim Notes", width: 60 },
  { key: "finalStatus", header: "Final status", width: 90 },
];

const errorColumns: Array<ColumnDef<BlueShieldErrorRow>> = [
  { key: "timestamp", header: "Timestamp", width: 26 },
  { key: "member_id", header: "Member ID", width: 18 },
  { key: "dos", header: "DOS", width: 22 },
  { key: "error_type", header: "Error Type", width: 24 },
  { key: "error_message", header: "Error Message", width: 70 },
  { key: "portal_url", header: "Portal URL", width: 48 },
];

const auditColumns: Array<ColumnDef<BlueShieldAuditRow>> = [
  { key: "timestamp", header: "Timestamp", width: 26 },
  { key: "member_id", header: "Member ID", width: 18 },
  { key: "step", header: "Step", width: 24 },
  { key: "status", header: "Status", width: 14 },
  { key: "duration_ms", header: "Duration (ms)", width: 16 },
  { key: "message", header: "Message", width: 70 },
];

function addSheet<T extends Record<string, unknown>>(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: T[],
  columns: Array<ColumnDef<T>>,
): void {
  const worksheet = workbook.addWorksheet(name);
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rows.length + 1, 2), column: columns.length },
  };
  worksheet.columns = columns.map((column) => ({
    header: column.header,
    key: String(column.key),
    width: column.width,
  }));

  const headerRow = worksheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD9EAF7" } },
      left: { style: "thin", color: { argb: "FFD9EAF7" } },
      bottom: { style: "thin", color: { argb: "FFD9EAF7" } },
      right: { style: "thin", color: { argb: "FFD9EAF7" } },
    };
  });

  for (const row of rows) {
    worksheet.addRow(Object.fromEntries(columns.map((column) => [String(column.key), row[column.key] ?? ""])));
  }

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: false };
      cell.border = {
        bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
      };
    });
  });
}

function inputColumnHeaders(rows: BlueShieldOutputRow[]): string[] {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.inputData)) {
      if (!headers.includes(key)) {
        headers.push(key);
      }
    }
  }
  return headers;
}

function addOutputSheet(workbook: ExcelJS.Workbook, rows: BlueShieldOutputRow[]): void {
  const inputHeaders = inputColumnHeaders(rows);
  const worksheet = workbook.addWorksheet("Output");
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rows.length + 1, 2), column: inputHeaders.length + outputColumns.length },
  };
  worksheet.columns = [
    ...inputHeaders.map((header) => ({ header, key: `input:${header}`, width: Math.max(14, Math.min(header.length + 4, 28)) })),
    ...outputColumns.map((column) => ({ header: column.header, key: String(column.key), width: column.width })),
  ];

  const headerRow = worksheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD9EAF7" } },
      left: { style: "thin", color: { argb: "FFD9EAF7" } },
      bottom: { style: "thin", color: { argb: "FFD9EAF7" } },
      right: { style: "thin", color: { argb: "FFD9EAF7" } },
    };
  });

  for (const row of rows) {
    worksheet.addRow({
      ...Object.fromEntries(inputHeaders.map((header) => [`input:${header}`, row.inputData[header] ?? ""])),
      ...Object.fromEntries(outputColumns.map((column) => [String(column.key), row[column.key] ?? ""])),
    });
  }

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: false };
      cell.border = {
        bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
      };
    });
  });
}

export async function createBlueShieldOutputWorkbookBuffer(state: BlueShieldWorkbookState): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claim Status Check";
  workbook.created = new Date();
  workbook.modified = new Date();

  const orderedOutputRows = [...state.outputRows].sort((left, right) => left.inputRowId - right.inputRowId);
  addOutputSheet(workbook, orderedOutputRows);
  addSheet(workbook, "Error", state.errorRows, errorColumns);
  addSheet(workbook, "Audit_Log", state.auditRows, auditColumns);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export async function createBlueShieldErrorReportBuffer(
  errorRows: BlueShieldErrorRow[],
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claim Status Check";
  workbook.created = new Date();
  workbook.modified = new Date();
  addSheet(workbook, "Blue Shield Errors", errorRows, errorColumns);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
