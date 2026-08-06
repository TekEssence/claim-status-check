import ExcelJS from "exceljs";
import type { PaymentPostingResultRow } from "../../types";

export const PAYMENT_POSTING_OUTPUT_COLUMNS = [
  "Input Row",
  "Workflow",
  "Portal",
  "Job ID",
  "Dry Run",
  "Posted",
  "Check Number Input",
  "Check Number Entered",
  "Payer Name Input",
  "Carrier Input",
  "Carrier Selected",
  "Check Amount Input",
  "Check Amount Entered",
  "Check/EFT Date Input",
  "Deposit Date Input",
  "Deposit Date Entered",
  "Patient Name Input",
  "Patient ID Input",
  "Patient Control Number Input",
  "Patient Selected",
  "Patient ID Selected",
  "Visit/Claim Input",
  "Visit/Claim Selected",
  "Visit Date/DOS",
  "DOS Input",
  "Visit Date Selected",
  "Payment Amount Input",
  "Payment Input",
  "Payment Amount Entered",
  "Excel CPT",
  "CPT Input",
  "Line Item Code",
  "CPT Match",
  "Excel Charge Amount",
  "Charge Input",
  "Line Item Charge",
  "Charge Match",
  "Line Match Result",
  "Insurance Portion",
  "Patient Portion",
  "Allowed Amount Input",
  "Insurance Allowed Entered",
  "Insurance Not Allowed",
  "Payment Entered",
  "Line Item Payment Entered",
  "Insurance Balance",
  "Patient Balance",
  "Write-Off Code",
  "Write-Off Amount",
  "Calculated Adjustment/Write-Off",
  "Adjustment Input",
  "Risk Code",
  "Risk Amount",
  "CARC Input",
  "CARC Selected",
  "RARC Input",
  "RARC Selected",
  "Denial Code Input",
  "Denial Code Selected",
  "Denial Code Description",
  "Reason Description Selected",
  "Status Input",
  "Final Displayed Status",
  "Provider",
  "Screenshot Filename",
  "Screenshot Path",
  "Screenshot Status",
  "Result",
  "Bot Message",
  "Error Details",
  "Started At",
  "Completed At",
  "Processing Time",
  "Filled Fields",
  "Skipped Fields",
] as const;

export async function createPaymentPostingOutputWorkbookBuffer(rows: PaymentPostingResultRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Payment Posting";
  workbook.created = new Date();

  const worksheet = workbook.addWorksheet("Payment Posting Results");
  const originalColumns = collectOriginalInputColumns(rows);
  worksheet.columns = [
    ...originalColumns.map((column) => ({ header: `Input: ${column}`, key: `input:${column}`, width: 24 })),
    ...PAYMENT_POSTING_OUTPUT_COLUMNS.map((column) => ({ header: column, key: column, width: column === "Bot Message" || column === "Error Details" ? 60 : 24 })),
  ];
  worksheet.getRow(1).font = { bold: true };
  worksheet.views = [{ state: "frozen", ySplit: 1 }];

  for (const row of rows) {
    const values: Record<string, string | number | boolean> = {};
    for (const column of originalColumns) {
      values[`input:${column}`] = row.originalInput[column] ?? "";
    }
    Object.assign(values, resultRowToWorksheetValues(row));
    worksheet.addRow(values);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
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

function resultRowToWorksheetValues(row: PaymentPostingResultRow): Record<string, string | number> {
  return {
    "Input Row": row.inputRow,
    Workflow: row.workflow,
    Portal: row.portal,
    "Job ID": row.jobId,
    "Dry Run": row.dryRun ? "Yes" : "No",
    Posted: row.posted ? "Yes" : "No",
    "Check Number Input": row.checkNumberInput,
    "Check Number Entered": row.checkNumberEntered,
    "Payer Name Input": row.payerNameInput,
    "Carrier Input": row.carrierInput,
    "Carrier Selected": row.carrierSelected,
    "Check Amount Input": row.checkAmountInput,
    "Check Amount Entered": row.checkAmountEntered,
    "Check/EFT Date Input": row.checkEftDateInput,
    "Deposit Date Input": row.checkEftDateInput,
    "Deposit Date Entered": row.depositDateEntered,
    "Patient Name Input": row.patientNameInput,
    "Patient ID Input": row.patientIdInput,
    "Patient Control Number Input": row.patientControlNumberInput,
    "Patient Selected": row.patientSelected,
    "Patient ID Selected": row.patientIdSelected,
    "Visit/Claim Input": row.visitClaimInput,
    "Visit/Claim Selected": row.visitClaimSelected,
    "Visit Date/DOS": row.visitDateDos,
    "DOS Input": row.visitDateDos,
    "Visit Date Selected": row.visitDateSelected,
    "Payment Amount Input": row.paymentAmountInput,
    "Payment Input": row.paymentAmountInput,
    "Payment Amount Entered": row.paymentAmountEntered,
    "Excel CPT": row.excelCpt,
    "CPT Input": row.excelCpt,
    "Line Item Code": row.lineItemCode,
    "CPT Match": row.cptMatch,
    "Excel Charge Amount": row.excelChargeAmount,
    "Charge Input": row.excelChargeAmount,
    "Line Item Charge": row.lineItemCharge,
    "Charge Match": row.chargeMatch,
    "Line Match Result": row.lineMatchResult,
    "Insurance Portion": row.insurancePortion,
    "Patient Portion": row.patientPortion,
    "Allowed Amount Input": row.allowedAmountInput,
    "Insurance Allowed Entered": row.insuranceAllowedEntered,
    "Insurance Not Allowed": row.insuranceNotAllowed,
    "Payment Entered": row.paymentEntered,
    "Line Item Payment Entered": row.paymentEntered,
    "Insurance Balance": row.insuranceBalance,
    "Patient Balance": row.patientBalance,
    "Write-Off Code": row.writeOffCode,
    "Write-Off Amount": row.writeOffAmount,
    "Calculated Adjustment/Write-Off": row.writeOffAmount,
    "Adjustment Input": row.adjustmentInput,
    "Risk Code": row.riskCode,
    "Risk Amount": row.riskAmount,
    "CARC Input": row.carcInput,
    "CARC Selected": row.carcSelected,
    "RARC Input": row.rarcInput,
    "RARC Selected": row.rarcSelected,
    "Denial Code Input": row.denialCodeInput,
    "Denial Code Selected": row.denialCodeSelected,
    "Denial Code Description": row.denialCodeDescription,
    "Reason Description Selected": row.reasonDescriptionSelected,
    "Status Input": row.statusInput,
    "Final Displayed Status": row.finalDisplayedStatus,
    Provider: row.provider,
    "Screenshot Filename": row.screenshotFilename,
    "Screenshot Path": row.screenshotPath,
    "Screenshot Status": row.screenshotStatus,
    Result: row.result,
    "Bot Message": row.botMessage,
    "Error Details": row.errorDetails,
    "Started At": row.startedAt,
    "Completed At": row.completedAt,
    "Processing Time": row.processingTime,
    "Filled Fields": row.filledFields,
    "Skipped Fields": row.skippedFields,
  };
}
