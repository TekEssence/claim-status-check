import type { EligibilityResult } from "../../types";

export function medRevenueDisplayCoverageStatus(result: EligibilityResult | undefined): string {
  if (!result) return "";
  const planStatus = String(result.planStatus ?? "").trim();
  if (result.payerId === "medicare" && /subscriber\s+not\s+found/i.test(planStatus)) {
    return "Subscriber Not Found";
  }
  return String(result.metadata?.medRevenueMedicarePartBStatus ?? result.coverageStatus ?? "");
}
