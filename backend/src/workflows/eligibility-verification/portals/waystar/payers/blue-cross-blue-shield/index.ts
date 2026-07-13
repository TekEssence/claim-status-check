import type {
  EligibilityCoverageStatus,
  EligibilityInputRow,
  EligibilityResult,
} from "../../../../types";
import type { WaystarPayerHandler } from "../types";

type BcbsHealthBenefitPlanCoveragePayload = {
  healthBenefitPlanCoverage?: {
    coverageDescription?: unknown;
    eligibilityBeginDate?: unknown;
    eligibilityEndDate?: unknown;
    planStatus?: unknown;
    planType?: unknown;
  };
};

const commonRequiredFields = ["memberId", "patientFirstName", "patientLastName", "dateOfBirth"];

export const blueCrossBlueShieldTexasPayer: WaystarPayerHandler = {
  id: "blue-cross-blue-shield-texas",
  name: "Blue Cross Blue Shield Texas",
  portalPayerName: "BCBS Texas(SB900)",
  insuranceNameAliases: [
    "blue cross and blue shield of texas",
    "blue cross blue shield of texas",
    "blue cross blue shield texas",
    "bcbs texas",
    "bcbstx",
  ],
  requiredFields: commonRequiredFields,
  parseResult(payload, row) {
    return parseBlueCrossBlueShieldResult(payload, row, "blue-cross-blue-shield-texas");
  },
};

export const blueCrossBlueShieldFloridaPayer: WaystarPayerHandler = {
  id: "blue-cross-blue-shield-florida",
  name: "Blue Cross Blue Shield Florida",
  portalPayerName: "BCBS Florida(SB590)",
  insuranceNameAliases: [
    "blue cross and blue shield of florida",
    "blue cross blue shield of florida",
    "blue cross blue shield florida",
    "bcbs florida",
    "bcbsfl",
    "florida blue",
  ],
  requiredFields: commonRequiredFields,
  parseResult(payload, row) {
    return parseBlueCrossBlueShieldResult(payload, row, "blue-cross-blue-shield-florida");
  },
};

export function parseBlueCrossBlueShieldResult(
  payload: unknown,
  row: EligibilityInputRow,
  payerId: string,
): EligibilityResult {
  const coverage = asBcbsPayload(payload).healthBenefitPlanCoverage;
  if (!coverage) {
    throw new Error("Missing Health Benefit Plan Coverage section in Waystar BCBS response.");
  }

  const planStatus = asText(coverage.planStatus);
  const coverageStatus = normalizeCoverageStatus(planStatus);
  const planType = normalizePlanType(asText(coverage.planType));
  const planName = asText(coverage.coverageDescription);
  const effectiveDate = asText(coverage.eligibilityBeginDate);
  const terminationDate = asText(coverage.eligibilityEndDate);

  return {
    rowIndex: row.originalIndex,
    payerId,
    coverageStatus,
    planType,
    planName,
    planStatus,
    effectiveDate,
    terminationDate,
    benefits: [
      {
        serviceType: "30 - Health Benefit Plan Coverage",
        coverageStatus,
        notes: planStatus || undefined,
      },
    ],
    metadata: {
      healthBenefitPlanCoverage: {
        planType,
        planName,
        planStatus,
        eligibilityBeginDate: effectiveDate,
        eligibilityEndDate: terminationDate,
      },
    },
  };
}

function asBcbsPayload(payload: unknown): BcbsHealthBenefitPlanCoveragePayload {
  if (!payload || typeof payload !== "object") return {};
  return payload as BcbsHealthBenefitPlanCoveragePayload;
}

function normalizeCoverageStatus(value: string): EligibilityCoverageStatus {
  const normalized = value.toLowerCase();
  if (normalized.includes("inactive")) return "inactive";
  if (normalized.includes("active")) return "active";
  return "unknown";
}

function normalizePlanType(value: string): string | undefined {
  if (!value) return undefined;
  const match = value.match(/\(([^)]+)\)/);
  return match?.[1]?.trim() || value.trim();
}

function asText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text || undefined;
}
