import type { EligibilityProjectId } from "../../../../projects";

export type AvailityProjectConfig = {
  id: EligibilityProjectId;
  inquiryMode?: "member-search";
  requireInputProjectColumn?: boolean;
  provider?: string;
  providerNpi?: string;
  state?: string;
  payers?: Readonly<Record<string, { portalPayerName: string; insuranceNameAliases: readonly string[] }>>;
  selectors?: Readonly<Record<string, string>>;
  selectorFallbacks?: Readonly<Record<string, string>>;
};
