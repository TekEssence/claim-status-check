import ExcelJS from "exceljs";
import type { WaystarAuditRow, WaystarErrorRow, WaystarOutputRow } from "./types";

const OUTPUT_COLUMNS: Array<{ key: keyof WaystarOutputRow; header: string; width: number }> = [
  { key: "sno", header: "sno", width: 8 },
  { key: "name", header: "NAME", width: 24 },
  { key: "servDate", header: "SERV DATE", width: 14 },
  { key: "icn", header: "ICN", width: 16 },
  { key: "acnt", header: "ACNT", width: 14 },
  { key: "eft", header: "EFT", width: 16 },
  { key: "productionDate", header: "PRODUCTION DATE", width: 18 },
  { key: "checkDate", header: "CHECK DATE", width: 14 },
  { key: "proc", header: "PROC", width: 12 },
  { key: "checkAmt", header: "CHECK AMT", width: 14 },
  { key: "billed", header: "BILLED", width: 12 },
  { key: "allowed", header: "ALLOWED", width: 12 },
  { key: "deduct", header: "DEDUCT", width: 12 },
  { key: "coins", header: "COINS", width: 12 },
  { key: "provPd", header: "PROV PD", width: 12 },
  { key: "denialCode1", header: "Denial Code1", width: 14 },
  { key: "denialReason1", header: "Denial Reason `", width: 48 },
  { key: "denialCode2", header: "Denial Code 2", width: 14 },
  { key: "denialReason2", header: "denial reason 2", width: 24 },
  { key: "denialCode3", header: "Denial Code 3", width: 14 },
  { key: "denialReason3", header: "denial reason 3", width: 24 },
  { key: "status", header: "status", width: 12 },
  { key: "remarks", header: "Remarks", width: 34 },
];

const ERROR_COLUMNS: Array<{ key: keyof WaystarErrorRow; header: string; width: number }> = [
  { key: "timestamp", header: "Timestamp", width: 26 },
  { key: "inputRowId", header: "Input Row", width: 12 },
  { key: "patientName", header: "Patient Name", width: 26 },
  { key: "responsiblePayer", header: "Responsible Payer", width: 24 },
  { key: "dos", header: "DOS", width: 16 },
  { key: "errorType", header: "Error Type", width: 24 },
  { key: "errorMessage", header: "Error Message", width: 70 },
];

const AUDIT_COLUMNS: Array<{ key: keyof WaystarAuditRow; header: string; width: number }> = [
  { key: "timestamp", header: "Timestamp", width: 26 },
  { key: "inputRowId", header: "Input Row", width: 12 },
  { key: "step", header: "Step", width: 24 },
  { key: "status", header: "Status", width: 14 },
  { key: "message", header: "Message", width: 70 },
];

function styleHeader(row: ExcelJS.Row) {
  row.height = 28;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD9EAF7" } },
      left: { style: "thin", color: { argb: "FFD9EAF7" } },
      bottom: { style: "thin", color: { argb: "FFD9EAF7" } },
      right: { style: "thin", color: { argb: "FFD9EAF7" } },
    };
  });
}

function styleBody(worksheet: ExcelJS.Worksheet) {
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber == 1) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: false };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE5E7EB" } } };
    });
  });
}

function addSimpleSheet<T extends Record<string, unknown>>(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: T[],
  columns: Array<{ key: keyof T; header: string; width: number }>,
) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.columns = columns.map((column) => ({
    key: String(column.key),
    header: column.header,
    width: column.width,
  }));
  styleHeader(worksheet.getRow(1));
  for (const row of rows) {
    worksheet.addRow(Object.fromEntries(columns.map((column) => [String(column.key), row[column.key] ?? ""])));
  }
  styleBody(worksheet);
}

function addOutputSheet(workbook: ExcelJS.Workbook, rows: WaystarOutputRow[]) {
  const worksheet = workbook.addWorksheet("Output");
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.columns = OUTPUT_COLUMNS.map((column) => ({
    header: column.header,
    key: String(column.key),
    width: column.width,
  }));
  styleHeader(worksheet.getRow(1));
  for (const row of rows) {
    worksheet.addRow(Object.fromEntries(OUTPUT_COLUMNS.map((column) => [String(column.key), row[column.key] ?? ""])));
  }
  styleBody(worksheet);
}

export async function createWaystarOutputWorkbookBuffer(options: {
  outputRows: WaystarOutputRow[];
  errorRows: WaystarErrorRow[];
  auditRows: WaystarAuditRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claim Status Check";
  workbook.created = new Date();
  workbook.modified = new Date();
  addOutputSheet(workbook, options.outputRows);
  addSimpleSheet(workbook, "Error", options.errorRows, ERROR_COLUMNS);
  addSimpleSheet(workbook, "Audit_Log", options.auditRows, AUDIT_COLUMNS);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
