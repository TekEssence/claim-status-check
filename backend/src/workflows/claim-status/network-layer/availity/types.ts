import type { BrowserContext, APIResponse } from "playwright-core";

export type AvailityNetworkClientOptions = {
  context: BrowserContext;
  baseUrl?: string;
  referer?: string;
  timeoutMs?: number;
  customerId?: string;
  clientId?: string;
};

export type AvailitySummarySearchRequest = {
  payerId: string;
  fromDate: string;
  toDate: string;
  providerNpi: string;
  submitterId?: string;
  requestedStatus?: string;
  requestType?: "SERVICE_DATE";
};

export type AvailityDetailSearchRequest = {
  parentTransactionId: string;
  payerId: string;
  requestType?: "CLAIM_NUMBER";
  claimNumber: string;
  claimIndex: number;
  providerNpi: string;
};

export type AvailitySearchEnvelope<T> = {
  completeCode?: number;
  traceIds?: Record<string, string>;
  errors?: unknown[];
  request?: Record<string, unknown>;
} & T;

export type AvailitySummarySearchResponse = AvailitySearchEnvelope<{
  items?: AvailitySummaryItem[];
  offset?: number;
  limit?: number;
  count?: number;
  totalCount?: number;
}>;

export type AvailitySummaryItem = {
  claimNumber?: string;
  status?: string;
  exchangeDate?: string;
  fromDate?: string;
  toDate?: string;
  amounts?: Record<string, { value?: string }>;
  subscriber?: {
    memberId?: string;
    firstName?: string;
    lastName?: string;
  };
  patient?: {
    firstName?: string;
    lastName?: string;
    birthDate?: string;
    accountNumber?: string;
    memberId?: string;
    additionalProperties?: Record<string, unknown>;
  };
  summary?: boolean;
};

export type AvailityDetailSearchResponse = AvailitySearchEnvelope<{
  claim?: AvailityClaimDetail;
}>;

export type AvailityClaimDetail = {
  type?: string;
  claimNumber?: string;
  status?: string;
  statusCode?: string;
  statusCodeDescription?: string;
  categoryCode?: string;
  categoryCodeDescription?: string;
  receivedDate?: string;
  exchangeDate?: string;
  effectiveDate?: string;
  fromDate?: string;
  toDate?: string;
  amounts?: Record<string, { value?: string }>;
  remittanceInfo?: AvailityRemittanceInfo[];
  subscriber?: {
    firstName?: string;
    lastName?: string;
    memberId?: string;
  };
  patient?: {
    firstName?: string;
    lastName?: string;
    birthDate?: string;
    accountNumber?: string;
    memberId?: string;
    additionalProperties?: Record<string, unknown>;
  };
  providers?: unknown[];
  statusDetails?: unknown[];
  serviceLines?: AvailityServiceLine[];
  additionalProperties?: Record<string, unknown>;
};

export type AvailityRemittanceInfo = {
  checkAmount?: string;
  checkNumber?: string;
  checkDate?: string;
  checkStatus?: string;
};

export type AvailityServiceLine = {
  lineNumber?: number;
  procedureCode?: string;
  procedureCodeDescription?: string;
  serviceCode?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  effectiveDate?: string;
  amounts?: Record<string, { value?: string }>;
  remarks?: Array<{
    code?: string;
    reason?: string;
  }>;
  statusDetails?: unknown[];
  adjustments?: unknown;
};

export type AvailityNormalizedSummaryRow = {
  claimNumber: string;
  status: string;
  serviceDate: string;
  toDate: string;
  billedAmount: string;
  insurancePaidAmount: string;
  memberId: string;
  patientName: string;
  patientAccountNumber: string;
  claimIndex: number;
  raw: AvailitySummaryItem;
};

export type AvailityNormalizedClaimDetail = {
  type: string;
  claimNumber: string;
  claimStatus: string;
  serviceDate: string;
  toDate: string;
  receivedDate: string;
  finalizedDate: string;
  checkNumber: string;
  checkDate: string;
  checkAmount: string;
  paidAmount: string;
  billedAmount: string;
  lines: AvailityNormalizedServiceLine[];
  raw: AvailityClaimDetail;
};

export type AvailityNormalizedServiceLine = {
  lineNumber: string;
  procedureCode: string;
  procedureDescription: string;
  status: string;
  serviceDate: string;
  toDate: string;
  effectiveDate: string;
  billed: string;
  allowed: string;
  paid: string;
  copay: string;
  coinsurance: string;
  deductible: string;
  remarkCode: string;
  description: string;
  remarks: Array<{
    code: string;
    reason: string;
  }>;
  raw: AvailityServiceLine;
};

export type AvailityAcceptedSearch = {
  id: string;
  location: string;
  response: APIResponse;
};
