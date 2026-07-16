import type { WaystarCredentials } from "../../../eligibility-verification/portals/waystar/credentials";

export type WaystarClaimInputRow = {
  inputRowId: number;
  originalIndex: number;
  patientName: string;
  claimNumber: string;
  responsiblePayer: string;
  dos: string;
  raw: Record<string, unknown>;
};

export type WaystarInvalidInputRow = {
  inputRowId: number;
  originalIndex: number;
  patientName: string;
  claimNumber: string;
  responsiblePayer: string;
  dos: string;
  raw: Record<string, unknown>;
  missingFields: string[];
  error: string;
};

export type WaystarParsedInput = {
  credentials: WaystarCredentials;
  claimRows: WaystarClaimInputRow[];
  invalidRows: WaystarInvalidInputRow[];
  inputHeaders: string[];
  totalRows: number;
  claimFileName: string;
  loginFileName: string;
};

export type WaystarProcedureLine = {
  serviceDate: string;
  proc: string;
  billed: string;
  allowed: string;
  deduct: string;
  coins: string;
  provPd: string;
  subTotals: string;
  denialCodes: string[];
  denialReasons: string[];
};

export type WaystarClaimExtraction = {
  name: string;
  icn: string;
  account: string;
  eft: string;
  productionDate: string;
  checkDate: string;
  checkAmount: string;
  status: "Paid" | "Denial" | "Calling";
  remarks: string;
  historySummary: string;
  procedureLines: WaystarProcedureLine[];
};

export type WaystarOutputRow = {
  sno: string;
  name: string;
  servDate: string;
  icn: string;
  acnt: string;
  eft: string;
  productionDate: string;
  checkDate: string;
  proc: string;
  checkAmt: string;
  billed: string;
  allowed: string;
  deduct: string;
  coins: string;
  provPd: string;
  denialCode1: string;
  denialReason1: string;
  denialCode2: string;
  denialReason2: string;
  denialCode3: string;
  denialReason3: string;
  status: string;
  remarks: string;
};

export type WaystarErrorRow = {
  timestamp: string;
  inputRowId: number;
  patientName: string;
  responsiblePayer: string;
  dos: string;
  errorType: string;
  errorMessage: string;
};

export type WaystarAuditRow = {
  timestamp: string;
  inputRowId: number;
  step: string;
  status: string;
  message: string;
};
