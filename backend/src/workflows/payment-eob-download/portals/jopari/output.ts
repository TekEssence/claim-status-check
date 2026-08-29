export type JopariPaymentRow = {
  eftCheckNumber: string;
  batchId: string;
  payDate: string;
  claimsPaid: string;
  paymentMethod: string;
  billingTin: string;
  paidAmount: string;
  payer: string;
  comparison: "Existing" | "Unique";
  searchResult: "Skipped" | "Found" | "Not found" | "Error";
  downloadStatus: "Skipped" | "Downloaded" | "Not downloaded" | "Error";
  filename: string;
  message: string;
};

export async function createJopariAuditWorkbook(rows: JopariPaymentRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Comparison Audit");
  worksheet.columns = [
    { header: "EFT/Check #", key: "eftCheckNumber", width: 18 },
    { header: "Batch ID", key: "batchId", width: 16 },
    { header: "Pay Date", key: "payDate", width: 14 },
    { header: "Claims Paid", key: "claimsPaid", width: 14 },
    { header: "Payment Method", key: "paymentMethod", width: 18 },
    { header: "Billing TIN", key: "billingTin", width: 16 },
    { header: "Paid Amount", key: "paidAmount", width: 16 },
    { header: "Payer", key: "payer", width: 28 },
    { header: "Comparison", key: "comparison", width: 14 },
    { header: "Search Result", key: "searchResult", width: 16 },
    { header: "Download Status", key: "downloadStatus", width: 18 },
    { header: "Filename", key: "filename", width: 28 },
    { header: "Message", key: "message", width: 52 },
  ];
  worksheet.addRows(rows);
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = { from: "A1", to: "M1" };
  worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
  worksheet.getRow(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1D4ED8" } };
  worksheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
import ExcelJS from "exceljs";
