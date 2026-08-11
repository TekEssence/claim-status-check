import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const bayCarePlusMedicareAdvantagePayer: WaystarPayerHandler = {
  id: "baycare-plus-medicare-advantage",
  name: "BayCare Plus Medicare Advantage",
  portalPayerName: "BayCare Plus Medicare Advantage (81079)",
  insuranceNameAliases: ["baycare plus medicare advantage", "baycare plus"],
  credentialProject: "FL2",
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    const result = parseWaystarEligibilityResult(payload, row, "baycare-plus-medicare-advantage");
    const coverage = (result.metadata?.subscriberCoverageInformation ?? {}) as {
      planBeginDate?: unknown;
      planEndDate?: unknown;
    };
return {
      rowIndex: result.rowIndex,
      payerId: result.payerId,
      coverageStatus: result.coverageStatus,
      effectiveDate: asText(coverage.planBeginDate),
      terminationDate: asText(coverage.planEndDate) ?? result.terminationDate,
      otherInsurance: result.otherInsurance,
      otherInsuranceEffectiveDate: result.otherInsuranceEffectiveDate,
      relationshipToSubscriber: result.relationshipToSubscriber || row.relationshipToSubscriber || "Self",
      planType: result.coverageDescription,
      insuranceType: result.insuranceType,
      benefits: [],
    };
  },
};

function asText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}