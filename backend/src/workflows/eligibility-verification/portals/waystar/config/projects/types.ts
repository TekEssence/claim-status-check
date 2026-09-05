import type { EligibilityProjectId } from "../../../../projects";

export type WaystarInquirySelectorKey =
  | "payerInput" | "payerSelect" | "provider" | "serviceType"
  | "patientLookup" | "memberId" | "lastName" | "firstName"
  | "dateOfBirth" | "submit";

export type WaystarPayerProjectConfig = {
  /** Tried only after the payer's existing portalPayerName fails. */
  portalPayerNameFallbacks?: readonly string[];
  serviceTypeCodeFallback?: string;
  patientLookupCodeFallback?: string;
  provider?: { name?: string; id?: string; tin?: string; npi?: string; ptan?: string };
  selectorFallbacks?: Partial<Record<WaystarInquirySelectorKey, string>>;
  outputMapping?: Readonly<Record<string, string>>;
  settings?: Readonly<Record<string, string | number | boolean>>;
};

export type WaystarProjectConfig = {
  id: EligibilityProjectId;
  /** The selected UI project may scope a dedicated workbook without a Project column. */
  requireInputProjectColumn?: boolean;
  credentialReference?: string;
  allowUnscopedCredentials?: boolean;
  payerNameMappings?: Readonly<Record<string, string>>;
  inputColumnMappings?: Readonly<Record<string, readonly string[]>>;
  outputMapping?: Readonly<Record<string, string>>;
  selectorFallbacks?: Partial<Record<WaystarInquirySelectorKey, string>>;
  settings?: Readonly<Record<string, string | number | boolean>>;
  payers?: Readonly<Record<string, WaystarPayerProjectConfig>>;
};
