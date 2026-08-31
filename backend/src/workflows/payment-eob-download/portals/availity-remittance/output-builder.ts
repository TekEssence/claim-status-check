import ExcelJS from "exceljs";
import type { PaymentEobComparisonRow, PaymentTrackerRow } from "../../types";

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

export async function createPaymentTrackerWorkbookBuffer(rows: PaymentTrackerRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Payment EOB Download";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Payment Tracker");
  worksheet.columns = [
    { header: "Source", key: "source", width: 14 },
    { header: "ERA Downloaded Date", key: "eraDownloadedDate", width: 22 },
    { header: "Payer Name", key: "payerName", width: 32 },
    { header: "Payee Name", key: "payeeName", width: 32 },
    { header: "Check/EFT #", key: "checkNumber", width: 24 },
    { header: "Check / EFT Date", key: "checkDate", width: 20 },
    { header: "Check Amount", key: "checkAmount", width: 18 },
  ];

  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) {
    const normalizedAmount = row.checkAmount.replace(/[$,\s]/g, "");
    const numericAmount = Number(normalizedAmount);
    worksheet.addRow({
      ...row,
      checkAmount: normalizedAmount && Number.isFinite(numericAmount) ? numericAmount : row.checkAmount,
    });
  }
  worksheet.getColumn("checkAmount").numFmt = "$#,##0.00";

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
