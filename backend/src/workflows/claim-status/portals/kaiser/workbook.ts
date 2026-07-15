import ExcelJS from "exceljs";

export type KaiserOutputRow = {
  inputData: Record<string, unknown>;
  inputRowId: number;
  botStatus: string;
  botMessage: string;
  memberId: string;
  dos: string;
  cptCode: string;
  claimNumber: string;
  claimStatus: string;
  checkEft: string;
  paymentDate: string;
  paymentAmount: string;
  service: string;
  serviceFrom: string;
  serviceTo: string;
  modifiers: string;
  quantity: string;
  claimCodes: string;
  billed: string;
  allowed: string;
  notCovered: string;
  deductible: string;
  coinsurance: string;
  copay: string;
  exceededBenefit: string;
  patientTotal: string;
  netPayable: string;
  claimCodeDescriptionTable: string;
  claimLevelCodes: string;
  serviceLevelDescription: string;
  denialSource: string;
  finalStatus: string;
};

export type KaiserAuditRow = {
  timestamp: string;
  inputRowId: number | "";
  memberId: string;
  step: string;
  status: string;
  message: string;
};

export type KaiserWorkbookState = {
  outputRows: KaiserOutputRow[];
  auditRows: KaiserAuditRow[];
};

type ColumnDef<T> = {
  key: keyof T;
  header: string;
  width: number;
};

const outputColumns: Array<ColumnDef<Omit<KaiserOutputRow, "inputData">>> = [
  { key: "inputRowId", header: "Input Row", width: 12 },
  { key: "botStatus", header: "Bot Status", width: 18 },
  { key: "botMessage", header: "Bot Message", width: 38 },
  { key: "memberId", header: "Member ID", width: 18 },
  { key: "dos", header: "DOS", width: 14 },
  { key: "cptCode", header: "CPT", width: 12 },
  { key: "claimNumber", header: "Claim #", width: 18 },
  { key: "claimStatus", header: "Status", width: 16 },
  { key: "checkEft", header: "Check/EFT", width: 18 },
  { key: "paymentDate", header: "Payment Date", width: 16 },
  { key: "paymentAmount", header: "Payment Amount", width: 18 },
  { key: "service", header: "Service", width: 52 },
  { key: "serviceFrom", header: "Service From", width: 16 },
  { key: "serviceTo", header: "Service To", width: 16 },
  { key: "modifiers", header: "Modifiers", width: 14 },
  { key: "quantity", header: "Quantity", width: 12 },
  { key: "claimCodes", header: "Claim Codes", width: 24 },
  { key: "billed", header: "Billed", width: 12 },
  { key: "allowed", header: "Allowed", width: 12 },
  { key: "notCovered", header: "Not Covered", width: 14 },
  { key: "deductible", header: "Deductible", width: 14 },
  { key: "coinsurance", header: "Coinsurance", width: 14 },
  { key: "copay", header: "Copay", width: 12 },
  { key: "exceededBenefit", header: "Exceeded Benefit", width: 18 },
  { key: "patientTotal", header: "Patient Total", width: 14 },
  { key: "netPayable", header: "Net Payable", width: 14 },
  { key: "claimCodeDescriptionTable", header: "Claim Code Description Table", width: 80 },
  { key: "claimLevelCodes", header: "Claim-Level Codes", width: 36 },
  { key: "serviceLevelDescription", header: "Service-Level Description", width: 70 },
  { key: "denialSource", header: "Denial Source", width: 18 },
  { key: "finalStatus", header: "Final Status", width: 90 },
];

const auditColumns: Array<ColumnDef<KaiserAuditRow>> = [
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
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0066A4" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
}

function inputColumnHeaders(rows: KaiserOutputRow[]): string[] {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.inputData)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  return headers;
}

function addOutputSheet(workbook: ExcelJS.Workbook, rows: KaiserOutputRow[]): void {
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

function addAuditSheet(workbook: ExcelJS.Workbook, rows: KaiserAuditRow[]): void {
  const worksheet = workbook.addWorksheet("Audit_Log");
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.columns = auditColumns.map((column) => ({ header: column.header, key: String(column.key), width: column.width }));
  styleHeader(worksheet);
  for (const row of rows) worksheet.addRow(row);
}

export async function createKaiserOutputWorkbookBuffer(state: KaiserWorkbookState): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Claim Status Check";
  workbook.created = new Date();
  workbook.modified = new Date();
  addOutputSheet(workbook, [...state.outputRows].sort((left, right) => left.inputRowId - right.inputRowId));
  addAuditSheet(workbook, state.auditRows);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}
