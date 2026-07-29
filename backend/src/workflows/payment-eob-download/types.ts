export type PaymentEobRunInput = {
  credentialExcel: File;
  referenceExcel: File;
};

export type PaymentEobCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  totpSecret: string;
  corporateId?: string;
  sharePoint?: PaymentEobSharePointCredentials;
  organization?: string;
  startDate?: string;
  endDate?: string;
  lookbackDays: number;
};

export type PaymentEobSharePointCredentials = {
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  siteUrl?: string;
  folderPath?: string;
};

export type PaymentEobReferenceRow = {
  rowNumber: number;
  checkNumber: string;
  checkDate?: string;
  raw: Record<string, string>;
};

export type PaymentEobPortalRecord = {
  checkNumber: string;
  checkDate: string;
  payer: string;
  payee: string;
  receivedByAvaility: string;
  amount: string;
  raw: Record<string, string>;
};

export type PaymentEobComparisonRow = {
  checkNumber: string;
  checkDate: string;
  comparison: "Existing" | "Unique";
  searchResult: "Skipped" | "Found" | "Not found" | "Error";
  pdfStatus: "Skipped" | "Downloaded" | "Not downloaded" | "Error";
  filename: string;
  message: string;
};
