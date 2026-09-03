import type { WaystarProjectConfig } from "./types";

/** MedRevenue reuses existing payer code; add only verified fallbacks here. */
export const medRevenueWaystarConfig: WaystarProjectConfig = {
  id: "medrevenue",
  requireInputProjectColumn: false,
  allowUnscopedCredentials: true,
  payers: { medicare: {} },
};
