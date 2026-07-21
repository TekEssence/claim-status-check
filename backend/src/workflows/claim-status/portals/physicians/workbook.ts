import ExcelJS from "exceljs";

export type PhysiciansOutputRow = {
  inputData: Record<string, unknown>;
  inputRowId: number;
  botStatus: string;
  botMessage: string;
  memberId: string;
  dos: string;
  dosTo: string;
  cptCode: string;
  providerClaimId: string;
  authorizationNumber: string;
  claimNumber: string;
  receivedDate: string;
  serviceDate: string;
  authNumber: string;
  placeOfService: string;
  member: string;
  provider: string;
  organization: string;
  renderingProvider: string;
  payee: string;
  billedAmount: string;
  contractAmount: string;
  netAmount: string;
  company: string;
  outcome: string;
  checkTotalAmount: string;
  authorizationDetails: string;
  serviceLineServiceDate: string;
  serviceCode: string;
  serviceModifier: string;
  diagnosisCode: string;
  financialResponsibility: string;
  adjustmentDescription: string;
  paidDate: string;
  checkNumber: string;
  quantity: string;
  billed: string;
  contract: string;
  copay: string;
  coinsurance: string;
  deductible: string;
  adjust: string;
  net: string;
  adminFeeWithhold: string;
  status: string;
  finalStatus: string;
};

export type PhysiciansAuditRow = {
  timestamp: string;
  inputRowId: number | "";
  memberId: string;
  step: string;
  status: string;
  message: string;
};

export type PhysiciansWorkbookState = {
  outputRows: PhysiciansOutputRow[];
  auditRows: PhysiciansAuditRow[];
};

type ColumnDef<T> = {
  key: keyof T;
  header: string;
  width: number;
};

const outputColumns: Array<ColumnDef<Omit<PhysiciansOutputRow, "inputData">>> = [
  { key: "inputRowId", header: "Input Row", width: 12 },
  { key: "botStatus", header: "Bot Status", width: 20 },
  { key: "botMessage", header: "Bot Message", width: 44 },
  { key: "memberId", header: "Member ID", width: 18 },
  { key: "dos", header: "DOS From", width: 14 },
  { key: "dosTo", header: "DOS To", width: 14 },
  { key: "cptCode", header: "CPT", width: 12 },
  { key: "providerClaimId", header: "Provider Claim ID", width: 24 },
  { key: "authorizationNumber", header: "Input Authorization #", width: 22 },
  { key: "claimNumber", header: "Claim #", width: 24 },
  { key: "receivedDate", header: "Received Date", width: 16 },
  { key: "serviceDate", header: "Service Date", width: 16 },
  { key: "authNumber", header: "Auth #", width: 24 },
  { key: "payee", header: "Payee", width: 18 },
  { key: "billedAmount", header: "Billed Amount", width: 16 },
  { key: "contractAmount", header: "Contract Amount", width: 18 },
  { key: "netAmount", header: "Net Amount", width: 16 },
  { key: "company", header: "Company", width: 12 },
  { key: "outcome", header: "Outcome", width: 18 },
  { key: "paidDate", header: "Paid Date", width: 16 },
  { key: "checkNumber", header: "Check #", width: 16 },
  { key: "serviceLineServiceDate", header: "Service Line Date", width: 22 },
  { key: "serviceCode", header: "ServiceCode", width: 18 },
  { key: "serviceModifier", header: "Modifier(s)", width: 14 },
  { key: "diagnosisCode", header: "Diag. Code", width: 14 },
  { key: "financialResponsibility", header: "Financial Resp.", width: 18 },
  { key: "adjustmentDescription", header: "Adjust Descr.", width: 34 },
  { key: "quantity", header: "Qty", width: 10 },
  { key: "billed", header: "Billed", width: 14 },
  { key: "contract", header: "Contract", width: 14 },
  { key: "copay", header: "CoPay", width: 14 },
  { key: "coinsurance", header: "Coinsurance", width: 14 },
  { key: "deductible", header: "Deductible", width: 14 },
  { key: "adjust", header: "Adjust", width: 14 },
  { key: "net", header: "Net", width: 14 },
  { key: "adminFeeWithhold", header: "Admin. Fee/Withhold", width: 20 },
  { key: "status", header: "Status", width: 14 },
  { key: "checkTotalAmount", header: "Check Total Amount", width: 20 },
  { key: "finalStatus", header: "Final Status", width: 90 },
];

const auditColumns: Array<ColumnDef<PhysiciansAuditRow>> = [
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
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFE97100" } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
}

// providerClaimId and authorizationNumber are already surfaced as their own output columns
// ("Provider Claim ID" / "Input Authorization #"), so they're skipped here to avoid showing the
// same value twice under their raw input-file key names.
const INPUT_ECHO_EXCLUDED_KEYS = new Set(["providerClaimId", "authorizationNumber"]);

function inputColumnHeaders(rows: PhysiciansOutputRow[]): string[] {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row.inputData)) {
      if (INPUT_ECHO_EXCLUDED_KEYS.has(key)) continue;
      if (!headers.includes(key)) headers.push(key);
    }
  }
  return headers;
}

export async function createPhysiciansOutputWorkbookBuffer(state: PhysiciansWorkbookState): Promise<Buffer> {
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