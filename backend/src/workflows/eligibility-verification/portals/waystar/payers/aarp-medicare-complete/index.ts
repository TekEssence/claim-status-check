import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

const requiredFields = ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"];

export const aarpMedicareCompletePayer: WaystarPayerHandler = {
  id: "aarp-medicare-complete",
  name: "AARP Medicare Complete",
  portalPayerName: "AARP Medicare Advantage Choice Plan (87726)",
  insuranceNameAliases: ["aarp medicare complete"],
  credentialProject: "FL2",
  requiredFields,
  parseResult(payload, row) {
    const result = parseWaystarEligibilityResult(payload, row, "aarp-medicare-complete");
    const coverage = (result.metadata?.subscriberCoverageInformation ?? {}) as {
      planBeginDate?: unknown;
      planEndDate?: unknown;
    };
    const dateRange = splitCoverageDateRange(coverage.planBeginDate);

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

function splitCoverageDateRange(value: unknown): { effectiveDate?: string; endDate?: string } {
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
