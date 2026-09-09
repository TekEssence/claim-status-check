import type { EligibilityProjectId } from "../../../../projects";

export type WaystarInquirySelectorKey =
  | "payerInput" | "payerSelect" | "provider" | "serviceType"
  | "patientLookup" | "memberId" | "lastName" | "firstName"
  | "dateOfBirth" | "planDateFrom" | "planDateTo" | "submit";

export type WaystarPayerProjectConfig = {
  requireSubscriberLookup?: boolean;
  /** Project-only portal payer name; the registered payer default is unchanged. */
  portalPayerName?: string;
  /** Search text only; selection must still match portalPayerName exactly. */
  payerSearchText?: string;
  /** Require an actual autocomplete item commit instead of accepting typed payer text. */
  requireExactPayerSuggestionCommit?: boolean;
  /** Tried only after the payer's existing portalPayerName fails. */
  portalPayerNameFallbacks?: readonly string[];
  serviceTypeCodeFallback?: string;
  serviceTypeDirectValue?: string;
  extractFullPayerResponse?: boolean;
  extractSecondaryCoverage?: boolean;
  extractUhcOtherCoverage?: boolean;
  patientLookupCodeFallback?: string;
  allowAutoPopulatedProviderFallback?: boolean;
  skipProviderHandling?: boolean;
  useDateOfServiceForPlanDates?: boolean;
  /** Also fill DOS before service-code selection for payers requiring that sequence. */
  fillPlanDatesBeforeServiceType?: boolean;
  planDateToOptional?: boolean;
  /** Response section whose first Plan Date should populate the output Plan Date. */
  responsePlanDateSectionTitle?: string;
  fillDateOfBirth?: boolean;
  memberIdAndDobOnly?: boolean;
  /** Restore the payer's demographic lookup and recheck patient values before submit. */
  restorePatientLookup?: boolean;
  repairPatientValueReset?: boolean;
  exactUmrDates?: boolean;
  retryPlanDatesWithKeyboard?: boolean;
  exactAetnaDates?: boolean;
  exactCignaPlanDate?: boolean;
  /** Use the workbook member ID without legacy payer-specific padding. */
  preserveMemberId?: boolean;
  /** Commit the visible plan-date field through keyboard input and blur. */
  typePlanDate?: boolean;
  provider?: { name?: string; id?: string; tin?: string; npi?: string; ptan?: string };
  selectorFallbacks?: Partial<Record<WaystarInquirySelectorKey, string>>;
  outputMapping?: Readonly<Record<string, string>>;
  settings?: Readonly<Record<string, string | number | boolean>>;
};

export type WaystarProjectRoutingRule = {
  payerId: string;
  /** An explicit insurance-name match takes precedence over member-ID heuristics. */
  preferInsuranceName?: boolean;
  insuranceNameAliases: readonly string[];
  insuranceNameMatch?: "contains";
  /** An alternative to the insurance-name condition, not an additional requirement. */
  memberIdPrefixAlternative?: string;
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
