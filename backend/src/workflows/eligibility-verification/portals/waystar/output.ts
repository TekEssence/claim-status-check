import * as XLSX from "xlsx";
import type { EligibilityInputRow, EligibilityResult } from "../../types";

const OUTPUT_COLUMNS: Array<{
  header: string;
  value: (row: EligibilityInputRow | undefined, result: EligibilityResult | undefined, error: string | undefined) => unknown;
}> = [
  { header: "Bot Entered First Name", value: (row) => row?.patientFirstName ?? "" },
  { header: "Bot Entered Last Name", value: (row) => row?.patientLastName ?? "" },
  { header: "Bot Entered Member ID", value: (row) => row?.memberId || row?.subscriberId || "" },
  { header: "Bot Entered Date of Birth", value: (row) => row?.dateOfBirth ?? "" },
  { header: "Bot Coverage Status", value: (_row, result) => result?.coverageStatus ?? "" },
  { header: "Bot Plan Type", value: (_row, result) => result?.planType ?? "" },
  { header: "Bot Plan Name", value: (_row, result) => result?.planName ?? "" },
  { header: "Bot Plan Status", value: (_row, result) => result?.planStatus ?? "" },
  { header: "Bot Effective Date", value: (_row, result) => result?.effectiveDate ?? "" },
  { header: "Bot Termination Date", value: (_row, result) => result?.terminationDate ?? "" },
  { header: "Bot Premium Paid End Date", value: (_row, result) => result?.premiumPaidEndDate ?? "" },
  { header: "Bot Insurance Type", value: (_row, result) => result?.insuranceType ?? "" },
  { header: "Bot Patient Name", value: (_row, result) => result?.patientName ?? "" },
  { header: "Bot Address", value: (_row, result) => result?.address ?? "" },
  { header: "Bot Member ID", value: (_row, result) => result?.memberId ?? "" },
  { header: "Bot Date of Birth", value: (_row, result) => result?.dateOfBirth ?? "" },
  { header: "Bot Sex", value: (_row, result) => result?.sex ?? "" },
  { header: "Bot Group Number", value: (_row, result) => result?.groupNumber ?? "" },
  { header: "Bot Plan Date", value: (_row, result) => result?.planDate ?? "" },
  { header: "Bot Primary Care Provider", value: (_row, result) => result?.primaryCareProvider ?? "" },
  { header: "Bot Coverage Description", value: (_row, result) => result?.coverageDescription ?? "" },
  { header: "Bot Coinsurance", value: (_row, result) => result?.coinsurance ?? "" },
  { header: "Bot Copay", value: (_row, result) => result?.copay ?? "" },
  { header: "Bot Deductible", value: (_row, result) => result?.deductible ?? "" },
  { header: "Bot Deductible Met", value: (_row, result) => result?.deductibleMet ?? "" },
  { header: "Bot Out of Pocket", value: (_row, result) => result?.outOfPocket ?? "" },
  { header: "Bot Out of Pocket Met", value: (_row, result) => result?.outOfPocketMet ?? "" },
  { header: "Bot Network", value: (_row, result) => result?.inOutNetwork ?? "" },
  {
    header: "Bot Benefits",
    value: (_row, result) => result?.benefits
      .map((benefit) => `${benefit.serviceType}: ${benefit.coverageStatus}${benefit.notes ? ` (${benefit.notes})` : ""}`)
      .join(" | ") ?? "",
  },
  { header: "Bot Error", value: (_row, _result, error) => error ?? "" },
];

export async function buildWaystarOutputWorkbook(options: {
  inputFile: File;
  rows: Map<number, EligibilityInputRow>;
  results: Map<number, EligibilityResult>;
  errors: Map<number, string>;
}): Promise<Buffer> {
  const workbook = XLSX.read(await options.inputFile.arrayBuffer(), {
    type: "array",
    cellDates: true,
  });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The eligibility workbook does not contain a worksheet.");

  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const outputStartColumn = range.e.c + 1;
  XLSX.utils.sheet_add_aoa(sheet, [OUTPUT_COLUMNS.map((column) => column.header)], {
    origin: { r: 0, c: outputStartColumn },
  });

  const rowIndexes = new Set([
    ...options.rows.keys(),
    ...options.results.keys(),
    ...options.errors.keys(),
  ]);
  for (const rowIndex of rowIndexes) {
    const row = options.rows.get(rowIndex);
    const result = options.results.get(rowIndex);
    const error = options.errors.get(rowIndex);
    XLSX.utils.sheet_add_aoa(
      sheet,
      [OUTPUT_COLUMNS.map((column) => column.value(row, result, error))],
      { origin: { r: rowIndex - 1, c: outputStartColumn } },
    );
  }

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
