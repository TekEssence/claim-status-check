"use strict";

const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");

const BOT_COLUMNS = [
  "bot_updated_claim_status",
  "bot_updated_time",
  "bot_search_source_tab",
  "bot_match_count",
  "bot_overall_result",
  "bot_notes"
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
  "needs_manual_review"
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
  "message"
];

function addSheet(workbook, name, columns, rows) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.addRow(columns);
  for (const row of rows) {
    worksheet.addRow(columns.map((column) => row[column] || ""));
  }
  worksheet.getRow(1).font = { bold: true };
  worksheet.columns.forEach((column) => {
    column.width = 24;
    column.alignment = { vertical: "top", wrapText: true };
  });
}

function getDateTimeStamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");

  const year = now.getFullYear();
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());

  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

async function writeOutputWorkbook({ runId, inputHeaders, inputRows, outputRows, errorRows, auditRows, partial = false }) {
  const workbook = new ExcelJS.Workbook();
  const inputColumns = ["input_row_id", ...inputHeaders, "validation_status", "validation_message"];
  const outputColumns = ["input_row_id", ...inputHeaders, ...BOT_COLUMNS];

  addSheet(workbook, "Input", inputColumns, inputRows);
  addSheet(workbook, "Output", outputColumns, outputRows);
  addSheet(workbook, "Error", ERROR_COLUMNS, errorRows);
  addSheet(workbook, "Audit_Log", AUDIT_COLUMNS, auditRows);

  const outputDir = path.resolve("output");
  fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = getDateTimeStamp();
  const fileName = partial
    ? `claim_status_output_partial_${timestamp}_${runId}.xlsx`
    : `claim_status_output_${timestamp}_${runId}.xlsx`;
  const outputPath = path.join(outputDir, fileName);
  await workbook.xlsx.writeFile(outputPath);
  return outputPath;
}

module.exports = {
  BOT_COLUMNS,
  writeOutputWorkbook
};
