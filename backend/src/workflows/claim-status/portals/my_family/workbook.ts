import ExcelJS from "exceljs";

export type MyFamilyOutputRow = {
  inputData: Record<string, unknown>;
  inputRowId: number;
  botStatus: string;
  botMessage: string;
  memberId: string;
  patientFirstName: string;
  patientLastName: string;
  dos: string;
  cptCode: string;
  claimNumber: string;
  memberName: string;
  providerName: string;
  providerClaimId: string;
  dateOfService: string;
  claimStatus: string;
  company: string;
  dateReceived: string;
  datePaid: string;
  checkNumber: string;
  paymentStatus: string;
  vendor: string;
  payee: string;
  claimType: string;
  serviceLines: string;
  finalStatus: string;
};

export type MyFamilyAuditRow = {
  timestamp: string;
  inputRowId: number | "";
  memberId: string;
  step: string;
  status: string;
  message: string;
};

export type MyFamilyWorkbookState = {
  outputRows: MyFamilyOutputRow[];
  auditRows: MyFamilyAuditRow[];
};

type ColumnDef<T> = {
  key: keyof T;
  header: string;
  width: number;
};

const outputColumns: Array<ColumnDef<Omit<MyFamilyOutputRow, "inputData">>> = [
  { key: "inputRowId", header: "Input Row", width: 12 },
  { key: "botStatus", header: "Bot Status", width: 20 },
  { key: "botMessage", header: "Bot Message", width: 42 },
  { key: "memberId", header: "Member ID", width: 18 },
  { key: "patientFirstName", header: "Patient First Name", width: 22 },
  { key: "patientLastName", header: "Patient Last Name", width: 22 },
  { key: "dos", header: "DOS", width: 14 },
  { key: "cptCode", header: "CPT", width: 12 },
  { key: "claimNumber", header: "Claim Number", width: 24 },
  { key: "memberName", header: "Member Name", width: 30 },
  { key: "providerName", header: "Provider Name", width: 28 },
  { key: "providerClaimId", header: "Provider Claim ID", width: 20 },
  { key: "dateOfService", header: "Date Of Service", width: 16 },
  { key: "claimStatus", header: "Claim Status", width: 18 },
  { key: "company", header: "Company", width: 12 },
  { key: "dateReceived", header: "Date Received", width: 16 },
  { key: "datePaid", header: "Date Paid", width: 16 },
  { key: "checkNumber", header: "Check", width: 16 },
  { key: "paymentStatus", header: "Payment Status", width: 18 },
  { key: "vendor", header: "Vendor", width: 16 },
  { key: "payee", header: "Payee", width: 18 },
  { key: "claimType", header: "Claim Type", width: 18 },
  { key: "serviceLines", header: "Service Lines", width: 100 },
  { key: "finalStatus", header: "Final Status", width: 90 },
];

const auditColumns: Array<ColumnDef<MyFamilyAuditRow>> = [
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
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F6FA8" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
}

function inputColumnHeaders(rows: MyFamilyOutputRow[]): string[] {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.inputData)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  return headers;
}

export async function createMyFamilyOutputWorkbookBuffer(state: MyFamilyWorkbookState): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claim Status Check";
  workbook.created = new Date();
  workbook.modified = new Date();

  const inputHeaders = inputColumnHeaders(state.outputRows);
  const outputSheet = workbook.addWorksheet("Output");
  outputSheet.views = [{ state: "frozen", ySplit: 1 }];
  outputSheet.columns = [
    ...inputHeaders.map((header) => ({ header, key: `input:${header}`, width: Math.max(14, Math.min(header.length + 4, 30)) })),
    ...outputColumns.map((column) => ({ header: column.header, key: String(column.key), width: column.width })),
  ];
  styleHeader(outputSheet);
  for (const row of [...state.outputRows].sort((left, right) => left.inputRowId - right.inputRowId)) {
    outputSheet.addRow({
      ...Object.fromEntries(inputHeaders.map((header) => [`input:${header}`, row.inputData[header] ?? ""])),
      ...Object.fromEntries(outputColumns.map((column) => [String(column.key), row[column.key] ?? ""])),
    });
  }

  const auditSheet = workbook.addWorksheet("Audit_Log");
  auditSheet.views = [{ state: "frozen", ySplit: 1 }];
  auditSheet.columns = auditColumns.map((column) => ({ header: column.header, key: String(column.key), width: column.width }));
  styleHeader(auditSheet);
  for (const row of state.auditRows) auditSheet.addRow(row);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
