import type { EligibilityProjectId } from "../../../../projects";

export type WaystarInquirySelectorKey =
  | "payerInput" | "payerSelect" | "provider" | "serviceType"
  | "patientLookup" | "memberId" | "lastName" | "firstName"
  | "dateOfBirth" | "planDateFrom" | "planDateTo" | "submit";

export type WaystarPayerProjectConfig = {
  /** Project-only portal payer name; the registered payer default is unchanged. */
  portalPayerName?: string;
  /** Require an actual autocomplete item commit instead of accepting typed payer text. */
  requireExactPayerSuggestionCommit?: boolean;
  /** Tried only after the payer's existing portalPayerName fails. */
  portalPayerNameFallbacks?: readonly string[];
  serviceTypeCodeFallback?: string;
  serviceTypeDirectValue?: string;
  extractFullPayerResponse?: boolean;
  patientLookupCodeFallback?: string;
  allowAutoPopulatedProviderFallback?: boolean;
  skipProviderHandling?: boolean;
  useDateOfServiceForPlanDates?: boolean;
  planDateToOptional?: boolean;
  fillDateOfBirth?: boolean;
  provider?: { name?: string; id?: string; tin?: string; npi?: string; ptan?: string };
  selectorFallbacks?: Partial<Record<WaystarInquirySelectorKey, string>>;
  outputMapping?: Readonly<Record<string, string>>;
  settings?: Readonly<Record<string, string | number | boolean>>;
};

export type WaystarProjectRoutingRule = {
  payerId: string;
  insuranceNameAliases: readonly string[];
  memberIdStartsWithAlphabetic?: boolean;
};

export type WaystarProjectConfig = {
  id: EligibilityProjectId;
  /** The selected UI project may scope a dedicated workbook without a Project column. */
  requireInputProjectColumn?: boolean;
  credentialReference?: string;
  allowUnscopedCredentials?: boolean;
  payerNameMappings?: Readonly<Record<string, string>>;
  payerRoutingRules?: readonly WaystarProjectRoutingRule[];
  inputColumnMappings?: Readonly<Record<string, readonly string[]>>;
  outputMapping?: Readonly<Record<string, string>>;
  selectorFallbacks?: Partial<Record<WaystarInquirySelectorKey, string>>;
  settings?: Readonly<Record<string, string | number | boolean>>;
  payers?: Readonly<Record<string, WaystarPayerProjectConfig>>;
};
