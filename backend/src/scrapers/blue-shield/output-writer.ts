import ExcelJS from "exceljs";
import type { BlueShieldAuditRow, BlueShieldClaimSummary, BlueShieldErrorRow } from "./types";

export type BlueShieldWorkbookState = {
  outputRows: BlueShieldClaimSummary[];
  errorRows: BlueShieldErrorRow[];
  auditRows: BlueShieldAuditRow[];
};

export function createBlueShieldWorkbookState(): BlueShieldWorkbookState {
  return { outputRows: [], errorRows: [], auditRows: [] };
}

type ColumnDef<T> = {
  key: keyof T;
  header: string;
  width: number;
};

const outputColumns: Array<ColumnDef<BlueShieldClaimSummary>> = [
  { key: "memberId", header: "Member ID", width: 18 },
  { key: "dosSearched", header: "DOS Searched", width: 24 },
  { key: "claimNumber", header: "Claim Number", width: 18 },
  { key: "claimType", header: "Claim Type", width: 16 },
  { key: "listClaimStatusLastModified", header: "Claim Status Last Modified", width: 26 },
  { key: "datesOfService", header: "Dates of Service", width: 22 },
  { key: "claimReceived", header: "Claim Received", width: 18 },
  { key: "memberName", header: "Member Name", width: 26 },
  { key: "listMemberIdSubscriberId", header: "Member ID / Subscriber ID", width: 26 },
  { key: "providerName", header: "Provider Name", width: 30 },
  { key: "detailProvider", header: "Detail Provider", width: 30 },
  { key: "providerNumber", header: "Provider Number", width: 20 },
  { key: "nationalProviderIdentifier", header: "National Provider Identifier (NPI)", width: 34 },
  { key: "ipaMedGroup", header: "IPA/Med Group", width: 24 },
  { key: "claimAmountBilled", header: "Claim Amount Billed", width: 20 },
  { key: "claimAmountPaid", header: "Claim Amount Paid", width: 20 },
  { key: "patientResponsibility", header: "Patient Responsibility", width: 22 },
  { key: "detailAmountBilled", header: "Detail Amount Billed", width: 20 },
  { key: "allowedAmount", header: "Allowed Amount", width: 18 },
  { key: "detailPatientResponsibility", header: "Detail Patient Responsibility", width: 26 },
  { key: "detailAmountPaid", header: "Detail Amount Paid", width: 20 },
  { key: "checkEftNumber", header: "Check/EFT Number", width: 20 },
  { key: "checkEftDate", header: "Check/EFT Date", width: 18 },
  { key: "checkEftStatus", header: "Check/EFT Status", width: 20 },
  { key: "checkEftAmount", header: "Check/EFT Amount", width: 20 },
  { key: "payeeName", header: "Payee Name", width: 28 },
  { key: "payeeAddress", header: "Payee Address", width: 36 },
  { key: "serviceLineNumber", header: "Line #", width: 10 },
  { key: "serviceLineDatesOfService", header: "Line Dates of Service", width: 22 },
  { key: "placeOfService", header: "Place of Service", width: 18 },
  { key: "units", header: "Units", width: 10 },
  { key: "procedureCode", header: "Procedure Code", width: 18 },
  { key: "modifier", header: "Modifier", width: 14 },
  { key: "serviceLineAmountBilled", header: "Line Amount Billed", width: 20 },
  { key: "serviceLineAllowedAmount", header: "Line Allowed Amount", width: 20 },
  { key: "serviceLineDeductible", header: "Deductible", width: 16 },
  { key: "serviceLineCopay", header: "Copay", width: 14 },
  { key: "serviceLineCoInsurance", header: "Co-Insurance", width: 16 },
  { key: "serviceLineAmountPaid", header: "Line Amount Paid", width: 18 },
  { key: "claimNotes", header: "Line Claim Notes", width: 60 },
  { key: "claimStatus", header: "Status", width: 14 },
];

const errorColumns: Array<ColumnDef<BlueShieldErrorRow>> = [
  { key: "timestamp", header: "Timestamp", width: 26 },
  { key: "member_id", header: "Member ID", width: 18 },
  { key: "dos", header: "DOS", width: 22 },
  { key: "error_type", header: "Error Type", width: 24 },
  { key: "error_message", header: "Error Message", width: 70 },
  { key: "portal_url", header: "Portal URL", width: 48 },
];

const auditColumns: Array<ColumnDef<BlueShieldAuditRow>> = [
  { key: "timestamp", header: "Timestamp", width: 26 },
  { key: "member_id", header: "Member ID", width: 18 },
  { key: "step", header: "Step", width: 24 },
  { key: "status", header: "Status", width: 14 },
  { key: "duration_ms", header: "Duration (ms)", width: 16 },
  { key: "message", header: "Message", width: 70 },
];

function addSheet<T extends Record<string, unknown>>(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: T[],
  columns: Array<ColumnDef<T>>,
): void {
  const worksheet = workbook.addWorksheet(name);
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(rows.length + 1, 2), column: columns.length },
  };
  worksheet.columns = columns.map((column) => ({
    header: column.header,
    key: String(column.key),
    width: column.width,
  }));

  const headerRow = worksheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1F4E78" },
    };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = {
      top: { style: "thin", color: { argb: "FFD9EAF7" } },
      left: { style: "thin", color: { argb: "FFD9EAF7" } },
      bottom: { style: "thin", color: { argb: "FFD9EAF7" } },
      right: { style: "thin", color: { argb: "FFD9EAF7" } },
    };
  });

  for (const row of rows) {
    worksheet.addRow(Object.fromEntries(columns.map((column) => [String(column.key), row[column.key] ?? ""])));
  }

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.eachCell((cell) => {
      cell.alignment = { vertical: "top", wrapText: false };
      cell.border = {
        bottom: { style: "hair", color: { argb: "FFE5E7EB" } },
      };
    });
  });
}

export async function createBlueShieldOutputWorkbookBuffer(state: BlueShieldWorkbookState): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claim Status Check";
  workbook.created = new Date();
  workbook.modified = new Date();

  addSheet(workbook, "Output", state.outputRows, outputColumns);
  addSheet(workbook, "Error", state.errorRows, errorColumns);
  addSheet(workbook, "Audit_Log", state.auditRows, auditColumns);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
