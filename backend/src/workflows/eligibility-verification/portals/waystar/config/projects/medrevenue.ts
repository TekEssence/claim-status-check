import type { WaystarProjectConfig } from "./types";

/** MedRevenue reuses existing payer code; add only verified fallbacks here. */
export const medRevenueWaystarConfig: WaystarProjectConfig = {
  id: "medrevenue",
  requireInputProjectColumn: false,
  allowUnscopedCredentials: true,
  inputColumnMappings: {
    dateOfService: ["Date of Service (DOS)", "Plan Date", "Plan Date(s)"],
  },
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
  },
};
