import * as XLSX from "xlsx";

type WorkbookLogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  url?: string;
};

type RegalWorkbookOptions = {
  auditLog?: WorkbookLogEntry[];
};

const REGAL_OUTPUT_HEADERS = [
  "input_row_number",
  "input_group",
  "input_member_name",
  "input_dos",
  "search_result_index",
  "search_member_name",
  "search_member_hmo_id",
  "search_provider_name",
  "search_claim_number",
  "search_first_date_of_service",
  "search_diagnosis",
  "search_billed",
  "search_pay_amount",
  "search_status",
  "final_status",
  "provider",
  "specialty",
  "claim_number",
  "claim_date",
  "member_id_name",
  "carrier",
  "line_seqnm",
  "line_cpt",
  "line_mod",
  "line_dos",
  "line_qty_unit",
  "line_billed",
  "line_allowed",
  "line_pay_amount",
  "line_status",
  "line_check_number",
  "line_check_date_finalized_date",
  "line_deductible",
  "line_copay",
  "line_coinsurance",
  "line_adjustment",
  "line_adjustment_reason",
  "line_final_adj",
  "line_final_adj_reason",
];

function appendSheet(workbook: XLSX.WorkBook, sheetName: string, rows: Record<string, unknown>[], headers: string[]): void {
  const normalizedRows = rows.length > 0
    ? rows.map((row) => Object.fromEntries(headers.map((header) => [header, row[header] ?? ""])))
    : [Object.fromEntries(headers.map((header) => [header, ""]))];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(normalizedRows, { header: headers }), sheetName);
}

function createAuditRows(entries: WorkbookLogEntry[] = []): Record<string, unknown>[] {
  return entries.map((entry) => ({
    timestamp: entry.timestamp,
    level: entry.level.toUpperCase(),
    stage: entry.stage,
    message: entry.message,
    url: entry.url ?? "",
  }));
}

export function createRegalOutputWorkbookBuffer(rows: Record<string, unknown>[], options: RegalWorkbookOptions = {}): Buffer {
  const workbook = XLSX.utils.book_new();
  const extraHeaders = Array.from(
    new Set(rows.flatMap((row) => Object.keys(row)).filter((header) => !REGAL_OUTPUT_HEADERS.includes(header))),
  );
  const headers = [...REGAL_OUTPUT_HEADERS, ...extraHeaders];
  appendSheet(workbook, "Output", rows, headers);

  const auditRows = createAuditRows(options.auditLog);
  const logHeaders = ["timestamp", "level", "stage", "message", "url"];
  appendSheet(workbook, "Audit Log", auditRows, logHeaders);

  const errorRows = auditRows.filter((row) => row.level === "WARN" || row.level === "ERROR");
  appendSheet(
    workbook,
    "Error Log",
    errorRows.length > 0
      ? errorRows
      : [{ timestamp: new Date().toISOString(), level: "INFO", stage: "summary", message: "No warnings or errors recorded.", url: "" }],
    logHeaders,
  );

  appendSheet(
    workbook,
    "Run Summary",
    [
      {
        generated_at: new Date().toISOString(),
        output_rows: rows.length,
        audit_log_entries: auditRows.length,
        warning_error_entries: errorRows.length,
      },
    ],
    ["generated_at", "output_rows", "audit_log_entries", "warning_error_entries"],
  );

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
