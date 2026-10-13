import ExcelJS from "exceljs";

export type EbridgeDownloadStatus = "Downloaded" | "Failed" | "Skipped" | "Cancelled" | "Pending";

export type EbridgeDocumentRow = {
  rowNumber: string;
  name: string;
  date: string;
  documentType: string;
  insuranceCompany: string;
  access: string;
  serviceLocation: string;
  batchLabel: string;
  indexedDate: string;
  type: string;
  pages: string;
  filename: string;
  status: EbridgeDownloadStatus;
  message: string;
};

export async function createEbridgeWorkbook(rows: EbridgeDocumentRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("eBridge Download Status");
  sheet.columns = [
    { header: "Grid Row", key: "rowNumber", width: 12 },
    { header: "Name", key: "name", width: 28 },
    { header: "Date", key: "date", width: 16 },
    { header: "Document Type", key: "documentType", width: 24 },
    { header: "Insurance Company", key: "insuranceCompany", width: 26 },
    { header: "Access", key: "access", width: 18 },
    { header: "Service Location", key: "serviceLocation", width: 28 },
    { header: "Batch Label", key: "batchLabel", width: 36 },
    { header: "Indexed Date", key: "indexedDate", width: 28 },
    { header: "Type", key: "type", width: 12 },
    { header: "Pages", key: "pages", width: 10 },
    { header: "PDF File Name", key: "filename", width: 42 },
    { header: "eBridge Download Status", key: "status", width: 28 },
    { header: "Message", key: "message", width: 60 },
  ];
  sheet.addRows(rows);
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = "A1:N1";
  sheet.getRow(1).font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
