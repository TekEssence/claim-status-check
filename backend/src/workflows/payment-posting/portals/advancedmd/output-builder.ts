import ExcelJS from "exceljs";
import type { PaymentPostingResultRow } from "../../types";

type WorksheetValue = string | number | boolean;

export const PAYMENT_POSTING_OUTPUT_COLUMNS = [
  "Input Row",
  "Patient Name",
  "Check #",
  "Result",
  "Last Successful Step",
  "Check Number Entered",
  "Carrier Selected",
  "Check Amount Entered",
  "Deposit Date Entered",
  "Patient Selected",
  "Patient ID Selected",
  "Visit/Claim Selected",
  "Visit Date Selected",
  "DOS Match",
  "Payment Amount Entered",
  "CPT Input",
  "Line Item Code",
  "CPT Match",
  "Charge Input",
  "Line Item Charge",
  "Charge Match",
  "Insurance Allowed Entered",
  "Line Item Payment Entered",
  "Write-Off Amount",
  "Denial Code Selected",
  "Denial Code Description",
  "Remark Code Selected",
  "Remark Code Description",
  "Status Input",
  "Status Selected",
  "Final Displayed Status",
  "Provider",
  "Screenshot Filename",
  "Screenshot Status",
  "Bot Message",
] as const;

const INPUT_SHEET = "Input";
const OUTPUT_SHEET = "Output";
const EXCEPTIONS_SHEET = "Exceptions";
const RUN_DETAILS_SHEET = "Run Details";

const EXCEPTION_COLUMNS = [
  "Input Row",
  "Patient Name",
  "Patient ID",
  "Patient Control Number",
  "Check #",
  "DOS",
  "CPT",
  "Charge",
  "Failure Stage",
  "Result",
  "Last Successful Step",
  "Expected Value",
  "Portal Value Found",
  "Reason",
  "Screenshot Filename",
  "Screenshot Status",
  "Bot Message",
] as const;

const RUN_DETAILS_COLUMNS = [
  "Input Row",
  "Job ID",
  "Workflow",
  "Portal",
  "Dry Run",
  "Posted",
  "Started At",
  "Completed At",
  "Processing Time",
  "Payer Name Input",
  "Carrier Input",
  "Check Amount Input",
  "Deposit Date Input",
  "Payment Amount Input",
  "Allowed Amount Input",
  "Adjustment Input",
  "CARC Input",
  "RARC Input",
  "Denial Code Input",
  "Remark Code Popup Status",
  "Remark Code Save Status",
  "DOS Input Raw",
  "DOS Input Short Format",
  "DOS Input Full Format",
  "DOS Input Canonical",
  "Visit Initial Option Count",
  "Visit Retry Performed",
  "Visit Final Option Count",
  "Visit Options Found Count",
  "Visit Options Found",
  "Visit Comparison Details",
  "Visit Time Selected",
  "Visit Date Canonical",
  "Visit Match Result",
  "Line Match Result",
  "Insurance Portion",
  "Patient Portion",
  "Insurance Not Allowed",
  "Insurance Balance",
  "Patient Balance",
  "Risk Code",
  "Risk Amount",
  "Previous Displayed Status",
  "Status Options Found",
  "Status Match",
  "Status Action",
  "Screenshot Path",
  "Filled Fields",
  "Skipped Fields",
  "Error Details",
] as const;

export async function createPaymentPostingOutputWorkbookBuffer(rows: PaymentPostingResultRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Payment Posting";
  workbook.created = new Date();

  addInputSheet(workbook, rows);
  addOutputSheet(workbook, rows);
  addExceptionsSheet(workbook, rows);
  addRunDetailsSheet(workbook, rows);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function addInputSheet(workbook: ExcelJS.Workbook, rows: PaymentPostingResultRow[]): void {
  const worksheet = workbook.addWorksheet(INPUT_SHEET);
  const originalColumns = collectOriginalInputColumns(rows);
  configureColumns(worksheet, originalColumns.map((column) => ({ header: column, key: column, width: inputColumnWidth(column) })));
  for (const row of rows) {
    const values: Record<string, WorksheetValue> = {};
    for (const column of originalColumns) values[column] = row.originalInput[column] ?? "";
    worksheet.addRow(values);
  }
  finalizeWorksheet(worksheet, originalColumns);
}

function addOutputSheet(workbook: ExcelJS.Workbook, rows: PaymentPostingResultRow[]): void {
  const worksheet = workbook.addWorksheet(OUTPUT_SHEET);
  configureColumns(worksheet, PAYMENT_POSTING_OUTPUT_COLUMNS.map((column) => ({ header: column, key: column, width: outputColumnWidth(column) })));
  for (const row of rows) worksheet.addRow(outputRowValues(row));
  finalizeWorksheet(worksheet, [...PAYMENT_POSTING_OUTPUT_COLUMNS]);
}

function addExceptionsSheet(workbook: ExcelJS.Workbook, rows: PaymentPostingResultRow[]): void {
  const worksheet = workbook.addWorksheet(EXCEPTIONS_SHEET);
  configureColumns(worksheet, EXCEPTION_COLUMNS.map((column) => ({ header: column, key: column, width: exceptionColumnWidth(column) })));
  for (const row of rows.filter(isExceptionRow)) worksheet.addRow(exceptionRowValues(row));
  finalizeWorksheet(worksheet, [...EXCEPTION_COLUMNS]);
}

function addRunDetailsSheet(workbook: ExcelJS.Workbook, rows: PaymentPostingResultRow[]): void {
  const worksheet = workbook.addWorksheet(RUN_DETAILS_SHEET);
  configureColumns(worksheet, RUN_DETAILS_COLUMNS.map((column) => ({ header: column, key: column, width: runDetailsColumnWidth(column) })));
  for (const row of rows) worksheet.addRow(runDetailsRowValues(row));
  finalizeWorksheet(worksheet, [...RUN_DETAILS_COLUMNS]);
}

function collectOriginalInputColumns(rows: PaymentPostingResultRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row.originalInput)) {
      if (!seen.has(column)) seen.add(column);
    }
  }
  return Array.from(seen);
}

function outputRowValues(row: PaymentPostingResultRow): Record<string, WorksheetValue> {
  return {
    "Input Row": row.inputRow,
    "Patient Name": row.patientNameInput,
    "Check #": row.checkNumberInput,
    Result: standardizedResult(row),
    "Last Successful Step": lastSuccessfulStep(row),
    "Check Number Entered": row.checkNumberEntered,
    "Carrier Selected": row.carrierSelected,
    "Check Amount Entered": row.checkAmountEntered,
    "Deposit Date Entered": row.depositDateEntered,
    "Patient Selected": cleanPatientSelected(row.patientSelected),
    "Patient ID Selected": row.patientIdSelected,
    "Visit/Claim Selected": row.visitClaimSelected,
    "Visit Date Selected": row.visitDateSelected,
    "DOS Match": row.dosMatch,
    "Payment Amount Entered": row.paymentAmountEntered,
    "CPT Input": row.excelCpt,
    "Line Item Code": row.lineItemCode,
    "CPT Match": row.cptMatch,
    "Charge Input": row.excelChargeAmount,
    "Line Item Charge": row.lineItemCharge,
    "Charge Match": row.chargeMatch,
    "Insurance Allowed Entered": row.insuranceAllowedEntered,
    "Line Item Payment Entered": row.paymentEntered,
    "Write-Off Amount": row.writeOffAmount,
    "Denial Code Selected": row.denialCodeSelected,
    "Denial Code Description": row.denialCodeDescription,
    "Remark Code Selected": row.denialCodeSelected,
    "Remark Code Description": row.denialCodeDescription || row.reasonDescriptionSelected,
    "Status Input": row.statusInput,
    "Status Selected": row.statusSelected,
    "Final Displayed Status": row.finalDisplayedStatus,
    Provider: row.provider,
    "Screenshot Filename": row.screenshotFilename,
    "Screenshot Status": row.screenshotStatus,
    "Bot Message": row.botMessage,
  };
}

function exceptionRowValues(row: PaymentPostingResultRow): Record<string, WorksheetValue> {
  return {
    "Input Row": row.inputRow,
    "Patient Name": row.patientNameInput,
    "Patient ID": row.patientIdInput,
    "Patient Control Number": row.patientControlNumberInput,
    "Check #": row.checkNumberInput,
    DOS: row.visitDateDos,
    CPT: row.excelCpt,
    Charge: row.excelChargeAmount,
    "Failure Stage": failureStage(row),
    Result: standardizedResult(row),
    "Last Successful Step": lastSuccessfulStep(row),
    "Expected Value": expectedValueForFailure(row),
    "Portal Value Found": portalValueForFailure(row),
    Reason: row.errorDetails || row.botMessage,
    "Screenshot Filename": row.screenshotFilename,
    "Screenshot Status": row.screenshotStatus,
    "Bot Message": row.botMessage,
  };
}

function runDetailsRowValues(row: PaymentPostingResultRow): Record<string, WorksheetValue> {
  return {
    "Input Row": row.inputRow,
    "Job ID": row.jobId,
    Workflow: row.workflow,
    Portal: row.portal,
    "Dry Run": row.dryRun ? "Yes" : "No",
    Posted: row.posted ? "Yes" : "No",
    "Started At": row.startedAt,
    "Completed At": row.completedAt,
    "Processing Time": row.processingTime,
    "Payer Name Input": row.payerNameInput,
    "Carrier Input": row.carrierInput,
    "Check Amount Input": row.checkAmountInput,
    "Deposit Date Input": row.checkEftDateInput,
    "Payment Amount Input": row.paymentAmountInput,
    "Allowed Amount Input": row.allowedAmountInput,
    "Adjustment Input": row.adjustmentInput,
    "CARC Input": row.carcInput,
    "RARC Input": row.rarcInput,
    "Denial Code Input": row.denialCodeInput,
    "Remark Code Popup Status": row.remarkCodePopupStatus,
    "Remark Code Save Status": row.remarkCodeSaveStatus,
    "DOS Input Raw": row.dosInputRaw,
    "DOS Input Short Format": row.dosInputShortFormat,
    "DOS Input Full Format": row.dosInputFullFormat,
    "DOS Input Canonical": row.dosInputCanonical,
    "Visit Initial Option Count": row.visitInitialOptionCount,
    "Visit Retry Performed": row.visitRetryPerformed,
    "Visit Final Option Count": row.visitFinalOptionCount,
    "Visit Options Found Count": row.visitOptionsFoundCount,
    "Visit Options Found": row.visitOptionsFound,
    "Visit Comparison Details": row.visitComparisonDetails,
    "Visit Time Selected": row.visitTimeSelected,
    "Visit Date Canonical": row.visitDateCanonical,
    "Visit Match Result": row.visitMatchResult,
    "Line Match Result": row.lineMatchResult,
    "Insurance Portion": row.insurancePortion,
    "Patient Portion": row.patientPortion,
    "Insurance Not Allowed": row.insuranceNotAllowed,
    "Insurance Balance": row.insuranceBalance,
    "Patient Balance": row.patientBalance,
    "Risk Code": row.riskCode,
    "Risk Amount": row.riskAmount,
    "Previous Displayed Status": row.previousDisplayedStatus,
    "Status Options Found": row.statusOptionsFound,
    "Status Match": row.statusMatch,
    "Status Action": row.statusAction,
    "Screenshot Path": row.screenshotPath,
    "Filled Fields": row.filledFields,
    "Skipped Fields": row.skippedFields,
    "Error Details": row.errorDetails,
  };
}

function isExceptionRow(row: PaymentPostingResultRow): boolean {
  return standardizedResult(row) !== "Success - Filled Not Posted";
}

function standardizedResult(row: PaymentPostingResultRow): string {
  if (row.result === "Filled - Not Posted") return "Success - Filled Not Posted";
  if (row.result === "Patient Not Selected") return "Patient Not Found";
  if (row.result === "Visit/Claim Not Found" && isDosMismatch(row)) return "DOS Not Matched";
  if (row.result === "CPT Not Matched") return "Line Item Not Found";
  if (row.result === "Charge Not Matched") return "CPT/Charge Mismatch";
  if (row.result === "CPT and Charge Not Matched") return "CPT/Charge Mismatch";
  if (row.result === "Ambiguous Line Item Match") return "CPT/Charge Mismatch";
  if (row.result === "Payment Reason Not Found") return row.denialCodeInput ? "Denial Code Not Found" : "Remark Code Not Found";
  if (row.result === "Screenshot Failed") return "Automation Error";
  if (row.result === "Validation Failed") return "Automation Error";
  if (row.result === "Cancelled") return "Automation Error";
  if (row.result === "Automation Failed") return automationFailureResult(row);
  return row.result;
}

function automationFailureResult(row: PaymentPostingResultRow): string {
  const details = `${row.botMessage} ${row.errorDetails}`.toLowerCase();
  if (details.includes("status not found")) return "Status Not Found";
  if (details.includes("denial code")) return "Denial Code Not Found";
  if (details.includes("remark code")) return "Remark Code Not Found";
  if (details.includes("line item") || details.includes("cpt") || details.includes("charge")) return "Line Item Not Found";
  if (isDosMismatch(row) || details.includes("dos not matched") || details.includes("dos mismatch")) return "DOS Not Matched";
  if (details.includes("visit/claim") || details.includes("dos")) return "Visit/Claim Not Found";
  if (details.includes("patient")) return "Patient Not Found";
  return "Automation Error";
}

function isDosMismatch(row: PaymentPostingResultRow): boolean {
  const details = `${row.botMessage} ${row.errorDetails} ${row.visitMatchResult} ${row.dosMatch}`.toLowerCase();
  return details.includes("dos not matched") || details.includes("dos mismatch") || row.dosMatch.toLowerCase() === "no";
}

function lastSuccessfulStep(row: PaymentPostingResultRow): string {
  if (row.result === "Filled - Not Posted") return "Completed - Not Posted";
  if (row.statusAction === "Updated" || row.finalDisplayedStatus) return "Status Updated";
  if (row.remarkCodeSaveStatus === "Saved" || row.denialCodeSelected) return "CARC/RARC Saved";
  if (row.paymentEntered) return "Payment Filled";
  if (row.insuranceAllowedEntered) return "Insurance Allowed Filled";
  if (row.lineMatchResult) return "Line Item Matched";
  if (row.paymentAmountEntered) return "Payment Amount Filled";
  if (row.visitClaimSelected) return "Visit/Claim Selected";
  if (row.patientSelected) return "Patient Selected";
  if (row.checkNumberEntered || row.carrierSelected || row.checkAmountEntered || row.depositDateEntered) return "EOB Filled";
  return "";
}

function failureStage(row: PaymentPostingResultRow): string {
  const result = standardizedResult(row);
  if (result.includes("Patient")) return "Patient";
  if (result.includes("Visit/Claim") || result.includes("DOS")) return "Visit/Claim";
  if (result.includes("Line Item") || result.includes("CPT") || result.includes("Charge")) return "Line Item";
  if (result.includes("Remark") || result.includes("Denial")) return "CARC/RARC";
  if (result.includes("Status")) return "Status";
  return "Automation";
}

function expectedValueForFailure(row: PaymentPostingResultRow): string {
  const stage = failureStage(row);
  if (stage === "Patient") return [row.patientNameInput, row.patientIdInput, row.patientControlNumberInput].filter(Boolean).join(" | ");
  if (stage === "Visit/Claim") return row.visitDateDos;
  if (stage === "Line Item") return [row.excelCpt, row.excelChargeAmount].filter(Boolean).join(" | ");
  if (stage === "CARC/RARC") return row.denialCodeInput || row.carcInput || row.rarcInput;
  if (stage === "Status") return row.statusInput;
  return "";
}

function portalValueForFailure(row: PaymentPostingResultRow): string {
  const stage = failureStage(row);
  if (stage === "Patient") return cleanPatientSelected(row.patientSelected);
  if (stage === "Visit/Claim") return row.visitOptionsFound || row.visitClaimSelected;
  if (stage === "Line Item") return [row.lineItemCode, row.lineItemCharge].filter(Boolean).join(" | ");
  if (stage === "CARC/RARC") return [row.denialCodeSelected, row.denialCodeDescription].filter(Boolean).join(" | ");
  if (stage === "Status") return row.statusOptionsFound || row.finalDisplayedStatus;
  return row.errorDetails;
}

function cleanPatientSelected(value: string): string {
  if (!value) return "";
  const marker = "This function requires";
  const markerIndex = value.indexOf(marker);
  return (markerIndex >= 0 ? value.slice(0, markerIndex) : value).trim();
}

function configureColumns(
  worksheet: ExcelJS.Worksheet,
  columns: Array<{ header: string; key: string; width: number }>,
): void {
  worksheet.columns = columns;
}

function finalizeWorksheet(worksheet: ExcelJS.Worksheet, columns: string[]): void {
  worksheet.views = [{ state: "frozen", ySplit: 1 }];
  worksheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, worksheet.rowCount), column: Math.max(1, columns.length) },
  };
  const header = worksheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: "middle", wrapText: true };
  worksheet.eachRow((row, rowNumber) => {
    row.alignment = { vertical: "top", wrapText: rowNumber !== 1 };
  });
}

function inputColumnWidth(column: string): number {
  if (/reason|remark/i.test(column)) return 32;
  if (/amount|charge|payment|check/i.test(column)) return 18;
  return 24;
}

function outputColumnWidth(column: string): number {
  if (column === "Bot Message") return 45;
  if (/Patient Selected|Provider/i.test(column)) return 30;
  if (/Amount|Charge|Payment|Check/i.test(column)) return 18;
  return 22;
}

function exceptionColumnWidth(column: string): number {
  if (/Reason|Bot Message|Portal Value Found|Expected Value/i.test(column)) return 45;
  return 22;
}

function runDetailsColumnWidth(column: string): number {
  if (/Details|Options Found|Screenshot Path|Error Details|Filled Fields|Skipped Fields/i.test(column)) return 55;
  if (/Started|Completed|Processing/i.test(column)) return 28;
  return 22;
}
