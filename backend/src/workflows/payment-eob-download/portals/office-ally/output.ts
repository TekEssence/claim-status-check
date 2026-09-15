import fs from "node:fs/promises";
import path from "node:path";
import ExcelJS from "exceljs";

export type OfficeAllyReport = {
  date: string;
  reportType: string;
  fileId: string;
  fileName: string;
  eobId: string;
  records: string;
  status: "Downloaded" | "Failed" | "Already saved" | "Cancelled" | "Pending";
};

export async function createOfficeAllyWorkbook(rows: OfficeAllyReport[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Office Ally Download Status");
  sheet.columns = [
    { header: "Date", key: "date", width: 15 },
    { header: "Report Type", key: "reportType", width: 24 },
    { header: "File ID", key: "fileId", width: 20 },
    { header: "File Name", key: "fileName", width: 60 },
    { header: "EOB ID", key: "eobId", width: 20 },
    { header: "# Records", key: "records", width: 15 },
    { header: "Office Ally Download Status", key: "status", width: 30 },
  ];
  sheet.addRows(rows);
  sheet.getColumn("fileId").numFmt = "@";
  sheet.getColumn("eobId").numFmt = "@";
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  sheet.autoFilter = "A1:G1";
  sheet.getRow(1).font = { bold: true };
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function validateOriginalFilename(filename: string): void {
  if (!filename || /[<>:"/\\|?*\x00-\x1f]/.test(filename) || /[. ]$/.test(filename)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])\./i.test(filename) || !/\.zip$/i.test(filename)) {
    throw new Error("The original download filename cannot be saved unchanged as a ZIP filename.");
  }
}

export async function saveOriginalZip(folder: string, filename: string, content: Buffer): Promise<"Downloaded" | "Already saved"> {
  validateOriginalFilename(filename);
  if (content.length < 22 || ![0x04034b50, 0x06054b50].includes(content.readUInt32LE(0))) {
    throw new Error("Office Ally returned an empty or non-ZIP download.");
  }
  const destination = path.join(folder, filename);
  try {
    await fs.writeFile(destination, content, { flag: "wx" });
    return "Downloaded";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(destination)).equals(content)) return "Already saved";
    throw new Error("A different ZIP already has this filename; the existing file was preserved.");
  }
}
