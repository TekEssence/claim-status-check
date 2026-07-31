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
  relationshipToSubscriber?: string;
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
  planType?: string;
  planName?: string;
  planStatus?: string;
  effectiveDate?: string;
  terminationDate?: string;
  premiumPaidEndDate?: string;
  insuranceType?: string;
  otherInsurance?: string;
  otherInsuranceEffectiveDate?: string;
  patientName?: string;
  relationshipToSubscriber?: string;
  address?: string;
  memberId?: string;
  dateOfBirth?: string;
  sex?: string;
  groupNumber?: string;
  planDate?: string;
  primaryCareProvider?: string;
  ipa?: string;
  coverageDescription?: string;
  coinsurance?: string;
  copay?: string;
  deductible?: string;
  deductibleMet?: string;
  outOfPocket?: string;
  outOfPocketMet?: string;
  inOutNetwork?: "INN" | "OON";
  specialistPayerNote?: "Specialist";
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
