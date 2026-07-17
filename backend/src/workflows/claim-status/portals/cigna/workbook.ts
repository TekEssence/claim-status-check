import ExcelJS from "exceljs";

export type CignaOutputRow = {
  inputData: Record<string, unknown>;
  inputRowId: number;
  botStatus: string;
  botMessage: string;
  memberId: string;
  patientFirstName: string;
  patientLastName: string;
  dateOfBirth: string;
  dos: string;
  cptCode: string;
  taxId: string;
  claimNumber: string;
  claimStatus: string;
  patientName: string;
  providerName: string;
  providerAccountNumber: string;
  dateReceived: string;
  dateProcessed: string;
  datesOfService: string;
  amountBilled: string;
  claimAmountDue: string;
  claimAmountPaid: string;
  totalProviderPayment: string;
  patientResponsibility: string;
  payeeName: string;
  payeeAddress: string;
  paymentAmount: string;
  remittanceTrackingNumber: string;
  paymentStatus: string;
  paymentIssued: string;
  paymentCleared: string;
  paymentMethod: string;
  procedureCode: string;
  procedureDatesOfService: string;
  placeOfService: string;
  amountCharged: string;
  allowedAmount: string;
  amountNotCovered: string;
  deductibleCopayApplied: string;
  coveredBalance: string;
  planCoinsurancePaid: string;
  patientCoinsurance: string;
  patientResponsibilityLine: string;
  remarkCodes: string;
  explanationOfRemarkCodes: string;
  finalStatus: string;
};

export type CignaAuditRow = {
  timestamp: string;
  inputRowId: number | "";
  memberId: string;
  step: string;
  status: string;
  message: string;
};

export type CignaWorkbookState = {
  outputRows: CignaOutputRow[];
  auditRows: CignaAuditRow[];
};

type ColumnDef<T> = {
  key: keyof T;
  header: string;
  width: number;
};

const excludedOutputHeaders = new Set(["Patient Name", "Provider Name", "Provider Account Number"]);

const outputColumns: Array<ColumnDef<Omit<CignaOutputRow, "inputData">>> = [
  { key: "inputRowId", header: "Input Row", width: 12 },
  { key: "botStatus", header: "Bot Status", width: 18 },
  { key: "botMessage", header: "Bot Message", width: 42 },
  { key: "memberId", header: "Member ID", width: 18 },
  { key: "patientFirstName", header: "First Name", width: 18 },
  { key: "patientLastName", header: "Last Name", width: 18 },
  { key: "dateOfBirth", header: "Date of Birth", width: 16 },
  { key: "dos", header: "DOS", width: 16 },
  { key: "cptCode", header: "CPT", width: 12 },
  { key: "taxId", header: "TIN", width: 16 },
  { key: "claimNumber", header: "Claim Number", width: 20 },
  { key: "claimStatus", header: "Claim Status", width: 16 },
  { key: "dateReceived", header: "Date Received", width: 16 },
  { key: "dateProcessed", header: "Date Processed", width: 16 },
  { key: "datesOfService", header: "Dates of Service", width: 24 },
  { key: "amountBilled", header: "Amount Billed", width: 16 },
  { key: "claimAmountDue", header: "Claim Amount Due", width: 18 },
  { key: "claimAmountPaid", header: "Claim Amount Paid", width: 18 },
  { key: "totalProviderPayment", header: "Total Provider Payment", width: 22 },
  { key: "patientResponsibility", header: "Patient Responsibility", width: 22 },
  { key: "payeeName", header: "Payee Name", width: 26 },
  { key: "payeeAddress", header: "Payee Address", width: 32 },
  { key: "paymentAmount", header: "Payment Amount", width: 18 },
  { key: "remittanceTrackingNumber", header: "Remittance Tracking Number", width: 28 },
  { key: "paymentStatus", header: "Payment Status", width: 18 },
  { key: "paymentIssued", header: "Payment Issued", width: 18 },
  { key: "paymentCleared", header: "Payment Cleared", width: 18 },
  { key: "paymentMethod", header: "Payment Method", width: 18 },
  { key: "procedureCode", header: "Procedure Code", width: 16 },
  { key: "procedureDatesOfService", header: "Procedure Dates of Service", width: 24 },
  { key: "placeOfService", header: "Place of Service", width: 18 },
  { key: "amountCharged", header: "Amount Charged", width: 18 },
  { key: "allowedAmount", header: "Allowed Amount", width: 18 },
  { key: "amountNotCovered", header: "Amount Not Covered", width: 20 },
  { key: "deductibleCopayApplied", header: "Deductible/Copay Applied", width: 24 },
  { key: "coveredBalance", header: "Covered Balance", width: 18 },
  { key: "planCoinsurancePaid", header: "Plan Coinsurance Paid", width: 22 },
  { key: "patientCoinsurance", header: "Patient Coinsurance", width: 22 },
  { key: "patientResponsibilityLine", header: "Patient Responsibility Line", width: 26 },
  { key: "remarkCodes", header: "Remark Codes", width: 22 },
  { key: "explanationOfRemarkCodes", header: "Explanation of Remark Codes", width: 80 },
  { key: "finalStatus", header: "Final Status", width: 90 },
];

const auditColumns: Array<ColumnDef<CignaAuditRow>> = [
  { key: "timestamp", header: "Timestamp", width: 26 },
  { key: "inputRowId", header: "Input Row", width: 12 },
  { key: "memberId", header: "Member ID", width: 18 },
  { key: "step", header: "Step", width: 24 },
  { key: "status", header: "Status", width: 14 },
  { key: "message", header: "Message", width: 80 },
];

function styleHeader(worksheet: ExcelJS.Worksheet): void {
  const headerRow = worksheet.getRow(1);
  headerRow.height = 28;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0033FF" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
}

function inputColumnHeaders(rows: CignaOutputRow[]): string[] {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.inputData)) {
      if (excludedOutputHeaders.has(key)) continue;
      if (!headers.includes(key)) headers.push(key);
    }
  }
  return headers;
}

function addOutputSheet(workbook: ExcelJS.Workbook, rows: CignaOutputRow[]): void {
  const inputHeaders = inputColumnHeaders(rows);
  const worksheet = workbook.addWorksheet("Output");
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.columns = [
    ...inputHeaders.map((header) => ({ header, key: `input:${header}`, width: Math.max(14, Math.min(header.length + 4, 30)) })),
    ...outputColumns.map((column) => ({ header: column.header, key: String(column.key), width: column.width })),
  ];
  styleHeader(worksheet);
  for (const row of rows) {
    worksheet.addRow({
      ...Object.fromEntries(inputHeaders.map((header) => [`input:${header}`, row.inputData[header] ?? ""])),
      ...Object.fromEntries(outputColumns.map((column) => [String(column.key), row[column.key] ?? ""])),
    });
  }
}

function addAuditSheet(workbook: ExcelJS.Workbook, rows: CignaAuditRow[]): void {
  const worksheet = workbook.addWorksheet("Audit_Log");
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.columns = auditColumns.map((column) => ({ header: column.header, key: String(column.key), width: column.width }));
  styleHeader(worksheet);
  for (const row of rows) worksheet.addRow(row);
}

export async function createCignaOutputWorkbookBuffer(state: CignaWorkbookState): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claim Status Check";
  workbook.created = new Date();
  workbook.modified = new Date();
  addOutputSheet(workbook, [...state.outputRows].sort((left, right) => left.inputRowId - right.inputRowId));
  addAuditSheet(workbook, state.auditRows);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
