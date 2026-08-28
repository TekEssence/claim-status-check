import ExcelJS from "exceljs";
import type { WaystarControlLogRow, WaystarSearchResult } from "./types";

function normalized(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }
function setAlias(values: Record<string, unknown>, headers: string[], aliases: string[], value: string): void {
  const wanted = new Set(aliases.map(normalized));
  const header = headers.find((candidate) => wanted.has(normalized(candidate)));
  if (header) values[header] = value;
}

export async function buildWaystarSearchResults(rows: WaystarSearchResult[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Search Results");
  const columns: Array<[string, string, number]> = [
    ["Client Name", "clientName", 28], ["Input Check Number", "inputCheckNumber", 24], ["Input Batch Total Amount", "inputBatchTotalAmount", 22],
    ["Search Result", "searchResult", 20], ["Portal Payment #", "portalPaymentNumber", 24], ["Portal Payment Amount", "portalPaymentAmount", 22],
    ["Portal Payment Date", "portalPaymentDate", 20], ["Portal Payer", "portalPayer", 36], ["Portal Type", "portalType", 14], ["Amount Match", "amountMatch", 16],
    ["PDF Status", "pdfStatus", 20], ["PDF File Name", "pdfFileName", 38], ["Archive Status", "archiveStatus", 22],
    ["Final Result", "finalResult", 20], ["Error", "error", 60],
  ];
  sheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export async function buildWaystarControlLog(headers: string[], rows: WaystarControlLogRow[], results: Map<number, WaystarSearchResult>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Control Log");
  sheet.addRow(headers);
  for (const row of rows) {
    const values = { ...row.values };
    const result = results.get(row.rowNumber);
    if (result?.finalResult === "DOWNLOAD_SUCCESS") {
      setAlias(values, headers, ["Client name", "Client Name"], row.clientName);
      setAlias(values, headers, ["File Name", "Filename"], result.pdfFileName);
      setAlias(values, headers, ["Source"], "Web");
      setAlias(values, headers, ["Mode of payment", "Payment Mode", "Type"], result.portalType);
      setAlias(values, headers, ["Check number", "Check Number", "Check #"], result.portalPaymentNumber);
      setAlias(values, headers, ["Posting Date", "Payment Date"], result.portalPaymentDate);
      setAlias(values, headers, ["Batch Total Amount", "Batch Amount"], result.portalPaymentAmount);
    }
    sheet.addRow(headers.map((header) => values[header] ?? ""));
  }
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
