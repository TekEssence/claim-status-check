export type EligibilityCoverageStatus =
  | "active"
  | "inactive"
  | "unknown"
  | "error";

export type EligibilityInputRow = {
  originalIndex: number;
  memberId?: string;
  subscriberId?: string;
  patientFirstName?: string;
  patientLastName?: string;
  dateOfBirth?: string;
  dateOfService?: string;
  serviceType?: string;
  raw: Record<string, unknown>;
};

export type EligibilityBenefit = {
  serviceType: string;
  coverageStatus: EligibilityCoverageStatus;
  copay?: string;
  coinsurance?: string;
  deductible?: string;
  notes?: string;
};

export type EligibilityResult = {
  rowIndex: number;
  payerId: string;
  coverageStatus: EligibilityCoverageStatus;
  planName?: string;
  effectiveDate?: string;
  terminationDate?: string;
  benefits: EligibilityBenefit[];
  metadata?: Record<string, unknown>;
};

export type EligibilityRunInput = {
  inputFile: File;
  credentialFile: File;
};

export type EligibilityPayerBatch = {
  payerId: string;
  payerName: string;
  rows: EligibilityInputRow[];
};
