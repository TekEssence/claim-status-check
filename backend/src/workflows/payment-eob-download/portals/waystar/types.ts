import type { WaystarCredentials } from "../../../eligibility-verification/portals/waystar/credentials";

export type WaystarPaymentCredentials = WaystarCredentials & { account: string };

export type WaystarControlLogRow = {
  rowNumber: number;
  values: Record<string, unknown>;
  clientName: string;
  checkNumber: string;
  batchTotalAmount: string;
  entryStatus: string;
  source: string;
};

export type WaystarPaymentRecord = {
  paymentAmount: string;
  paymentDate: string;
  payer: string;
  type: string;
  paymentNumber: string;
  rowIndex: number;
};

export type WaystarSearchResult = {
  clientName: string;
  inputCheckNumber: string;
  inputBatchTotalAmount: string;
  searchResult: "FOUND" | "NOT_FOUND" | "AMOUNT_MISMATCH" | "ERROR";
  portalPaymentNumber: string;
  portalPaymentAmount: string;
  portalPaymentDate: string;
  portalPayer: string;
  portalType: string;
  amountMatch: "YES" | "NO" | "";
  pdfStatus: "DOWNLOAD_SUCCESS" | "DOWNLOAD_FAILED" | "NOT_DOWNLOADED";
  pdfFileName: string;
  archiveStatus: "ARCHIVED_SUCCESS" | "ALREADY_ARCHIVED" | "ARCHIVE_FAILED" | "NOT_ATTEMPTED" | "NOT_APPLICABLE";
  finalResult: "DOWNLOAD_SUCCESS" | "DOWNLOAD_FAILED" | "NOT_FOUND" | "AMOUNT_MISMATCH" | "ERROR";
  error: string;
};
