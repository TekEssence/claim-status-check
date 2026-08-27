import type {
  PaymentEobComparisonRow,
  PaymentEobPortalRecord,
  PaymentTrackerRow,
} from "../../types";

export function addPaymentTrackerRow(
  rows: PaymentTrackerRow[],
  seenPayments: Set<string>,
  record: PaymentEobPortalRecord,
  result: PaymentEobComparisonRow,
  eraDownloadedDate: string,
): void {
  if (
    result.comparison !== "Unique"
    || result.searchResult !== "Found"
    || result.pdfStatus !== "Downloaded"
  ) return;

  const paymentIdentity = `${record.checkNumber}\u0000${record.checkDate}`;
  if (seenPayments.has(paymentIdentity)) return;
  seenPayments.add(paymentIdentity);

  rows.push({
    source: "Availity",
    eraDownloadedDate,
    payerName: record.payer,
    payeeName: record.payee,
    checkNumber: record.checkNumber,
    checkDate: record.checkDate,
    checkAmount: record.amount,
  });
}
