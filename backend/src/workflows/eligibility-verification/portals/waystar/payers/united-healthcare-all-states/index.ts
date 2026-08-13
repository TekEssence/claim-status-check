import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const unitedHealthcareAllStatesPayer: WaystarPayerHandler = {
  id: "united-healthcare-all-states",
  name: "United Healthcare of All States",
  portalPayerName: "United Healthcare(87726)",
  insuranceNameAliases: [
    "united healthcare of all states",
    "united healthcare all states",
    "united healthcare medicare solutions ppo",
    "united healthcare medicare solutions hmo",
    "uhc mcr advantage ppo",
    "uhc choice plus",
    "uhc aarp mcr complete focus hmo",
    "united healthcare",
    "uhc all states",
  ],
  credentialProject: "FL2",
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    const result = parseWaystarEligibilityResult(payload, row, "united-healthcare-all-states");
    const coverage = (result.metadata?.subscriberCoverageInformation ?? {}) as {
      planBeginDate?: unknown;
      planEndDate?: unknown;
    };
    const dateRange = splitWaystarCoverageDateRange(coverage.planBeginDate);
    return {
      rowIndex: result.rowIndex,
      payerId: result.payerId,
      coverageStatus: result.coverageStatus,
      effectiveDate: dateRange.effectiveDate,
      terminationDate: asText(coverage.planEndDate) ?? dateRange.endDate ?? result.terminationDate,
      otherInsurance: result.otherInsurance,
      otherInsuranceEffectiveDate: result.otherInsuranceEffectiveDate,
      relationshipToSubscriber: result.relationshipToSubscriber || row.relationshipToSubscriber || "Self",
      planType: result.coverageDescription,
      insuranceType: result.insuranceType,
      benefits: [],
    };
  },
};

export function splitWaystarCoverageDateRange(value: unknown): {
  effectiveDate?: string;
  endDate?: string;
} {
  const text = asText(value);
  if (!text) return {};
  const [effectiveDate, endDate] = text.split(/\s+to\s+/i, 2);
  return { effectiveDate: asText(effectiveDate), endDate: asText(endDate) };
}
function asText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
