import type { WaystarPayerHandler } from "../types";
import { parseWaystarEligibilityResult } from "../eligibility-result-parser";

export const aetnaMedicarePpoPayer: WaystarPayerHandler = {
  id: "aetna-medicare-ppo",
  name: "Aetna Medicare PPO",
  portalPayerName: "Aetna (Medicare Advantage) (60054MA)",
  insuranceNameAliases: ["aetna medicare ppo", "aetna medicare advantage"],
  credentialProject: "FL2",
  requiredFields: ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"],
  parseResult(payload, row) {
    const result = parseWaystarEligibilityResult(payload, row, "aetna-medicare-ppo");
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
      relationshipToSubscriber: result.relationshipToSubscriber ||
        row.relationshipToSubscriber ||
        "Self",
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
