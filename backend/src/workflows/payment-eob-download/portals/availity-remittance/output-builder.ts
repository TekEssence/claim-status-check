import ExcelJS from "exceljs";
import type { PaymentEobComparisonRow } from "../../types";

export async function createPaymentEobResultWorkbookBuffer(rows: PaymentEobComparisonRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Payment EOB Download";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Comparison Result");
  worksheet.columns = [
    { header: "Check/EFT Number", key: "checkNumber", width: 24 },
    { header: "Check Date", key: "checkDate", width: 16 },
    { header: "Comparison", key: "comparison", width: 16 },
    { header: "Search Result", key: "searchResult", width: 16 },
    { header: "PDF Status", key: "pdfStatus", width: 18 },
    { header: "Filename", key: "filename", width: 32 },
    { header: "Message", key: "message", width: 70 },
  ];

  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) {
    worksheet.addRow(row);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

