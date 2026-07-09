import ExcelJS from "exceljs";
import type { AvailityAuditRow, AvailityErrorRow, AvailityOutputRow } from "./types";

const BOT_COLUMNS = [
  "bot_updated_claim_status",
  "bot_updated_time",
  "bot_search_source_tab",
  "bot_match_count",
  "bot_overall_result",
  "bot_notes",
];

const ERROR_COLUMNS = [
  "run_id",
  "input_row_id",
  "payer_name",
  "claim_no",
  "service_date",
  "charges",
  "search_source_tab",
  "failure_stage",
  "failure_reason",
  "current_url",
  "needs_manual_review",
];

const AUDIT_COLUMNS = [
  "run_id",
  "timestamp",
  "input_row_id",
  "payer_name",
  "claim_no",
  "step",
  "status",
  "duration_ms",
  "retry_count",
  "message",
];

function addSheet(workbook: ExcelJS.Workbook, name: string, columns: string[], rows: Record<string, unknown>[]): void {
  const worksheet = workbook.addWorksheet(name);
  worksheet.addRow(columns);
  for (const row of rows) {
    worksheet.addRow(columns.map((column) => row[column] ?? ""));
  }
  worksheet.getRow(1).font = { bold: true };
  worksheet.columns.forEach((column) => {
    column.width = 24;
    column.alignment = { vertical: "top", wrapText: true };
  });
}

export async function createAvailityOutputWorkbookBuffer(options: {
  inputHeaders: string[];
  inputRows: AvailityOutputRow[];
  outputRows: AvailityOutputRow[];
  errorRows: AvailityErrorRow[];
  auditRows: AvailityAuditRow[];
}): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  addSheet(workbook, "Input", ["input_row_id", ...options.inputHeaders, "validation_status", "validation_message"], options.inputRows);
  addSheet(workbook, "Output", ["input_row_id", ...options.inputHeaders, ...BOT_COLUMNS], options.outputRows);
  addSheet(workbook, "Error", ERROR_COLUMNS, options.errorRows);
  addSheet(workbook, "Audit_Log", AUDIT_COLUMNS, options.auditRows);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
