import * as XLSX from "xlsx";

export function createRegalOutputWorkbookBuffer(rows: Record<string, unknown>[]): Buffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Output");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
