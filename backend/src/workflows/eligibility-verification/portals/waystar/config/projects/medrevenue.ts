import type { WaystarProjectConfig } from "./types";

/** MedRevenue reuses existing payer code; add only verified fallbacks here. */
export const medRevenueWaystarConfig: WaystarProjectConfig = {
  id: "medrevenue",
  requireInputProjectColumn: false,
  allowUnscopedCredentials: true,
  inputColumnMappings: {
    dateOfService: ["Date of Service (DOS)", "Plan Date", "Plan Date(s)"],
  },
  payerRoutingRules: [{
    payerId: "bcbs-ppo",
    insuranceNameAliases: ["Blue Cross", "Blue Cross California"],
    memberIdStartsWithAlphabetic: true,
  }],
  payers: {
    medicare: {
      skipProviderHandling: true,
      useDateOfServiceForPlanDates: true,
      fillDateOfBirth: true,
      serviceTypeDirectValue: "30",
      extractFullPayerResponse: true,
      selectorFallbacks: {
        planDateFrom: "#txtPlanFrom",
        planDateTo: "#txtPlanTo",
        dateOfBirth: "#DOB",
      },
    },
    "bcbs-ppo": {
      portalPayerName: "Blue Cross California (SB040)",
      requireExactPayerSuggestionCommit: true,
      skipProviderHandling: true,
      useDateOfServiceForPlanDates: true,
      planDateToOptional: true,
      fillDateOfBirth: true,
      serviceTypeDirectValue: "30",
      selectorFallbacks: {
        planDateFrom: "#txtPlanFrom",
      },
    },
  },
};
