import { UnknownPortalError } from "../../../../core/errors";
import { aetnaMedicarePpoPayer } from "./payers/aetna-medicare-ppo";
import { aetnaPayer } from "./payers/aetna";
import { aarpMedicareCompletePayer } from "./payers/aarp-medicare-complete";
import { unitedHealthcareAllStatesPayer } from "./payers/united-healthcare-all-states";
import { amerigroupWellpointPayer } from "./payers/amerigroup";
import { bayCarePlusMedicareAdvantagePayer } from "./payers/baycare-plus-medicare-advantage";
import { bcbsPpoPayer } from "./payers/bcbs-ppo";
import { cignaOpenAccessPlusPayer } from "./payers/cigna-open-access-plus";
import { medicarePayer } from "./payers/medicare";
import { avMedPayer } from "./payers/av-med";
import { humanaMedicarePpoPayer } from "./payers/humana-medicare-ppo";
import { umrPayer } from "./payers/umr";
import type { WaystarPayerHandler } from "./payers/types";
import { medRevenueBlueShieldPayer } from "./payers/blue-shield";
import { parseWaystarEligibilityResult } from "./payers/eligibility-result-parser";
import { applyMedRevenueUhcOtherCoverage } from "./payers/united-healthcare-all-states/medrevenue-other-coverage";

export const waystarPayerRegistry = {
  medicare: medicarePayer,
  "av-med": avMedPayer,
  "humana-medicare-ppo": humanaMedicarePpoPayer,
  "aetna-medicare-ppo": aetnaMedicarePpoPayer,
  aetna: aetnaPayer,
  "aarp-medicare-complete": aarpMedicareCompletePayer,
  "united-healthcare-all-states": unitedHealthcareAllStatesPayer,
  "amerigroup-wellpoint": amerigroupWellpointPayer,
  "baycare-plus-medicare-advantage": bayCarePlusMedicareAdvantagePayer,
  "bcbs-ppo": bcbsPpoPayer,
  "cigna-open-access-plus": cignaOpenAccessPlusPayer,
  umr: umrPayer,
} satisfies Record<string, WaystarPayerHandler>;

export function getWaystarPayer(payerId: string, projectId?: string): WaystarPayerHandler {
  // Keep this payer out of the shared name matcher and Minimax registry.
  if (projectId === "medrevenue" && payerId === "blue-shield") return medRevenueBlueShieldPayer;
  if (projectId === "medrevenue" && payerId === "united-healthcare-all-states") {
    return {
      ...unitedHealthcareAllStatesPayer,
      name: "UHC",
      requiredFields: ["memberId", "dateOfBirth"],
      portalPayerName: "UHC (87726)",
      insuranceNameAliases: [...unitedHealthcareAllStatesPayer.insuranceNameAliases, "UHC", "UnitedHealthcare", "United Health Care"],
      parseResult(payload, row) {
        // Preserve MedRevenue's Plan Date and response metadata alongside the
        // established UHC coverage mapping. The Minimax parser is unchanged.
        return applyMedRevenueUhcOtherCoverage({
          ...parseWaystarEligibilityResult(payload, row, "united-healthcare-all-states"),
          ...unitedHealthcareAllStatesPayer.parseResult(payload, row),
        });
      },
    };
  }
  const payer = waystarPayerRegistry[payerId as keyof typeof waystarPayerRegistry];
  if (!payer) {
    throw new UnknownPortalError(`waystar/${payerId}`);
  }
  return payer;
}

export function matchWaystarPayer(insuranceName: string): WaystarPayerHandler | null {
  const normalizedName = normalizeLookupValue(insuranceName);
  if (!normalizedName) return null;

const payers = Object.values(waystarPayerRegistry);
  const exact = payers.find((payer) =>
    [payer.id, payer.name, payer.portalPayerName, ...payer.insuranceNameAliases]
      .map(normalizeLookupValue)
      .includes(normalizedName)
  );
  if (exact) return exact;

  return payers.find((payer) =>
    payer.insuranceNameAliases.some((alias) => {
      const normalizedAlias = normalizeLookupValue(alias);
      return normalizedName.startsWith(`${normalizedAlias} `) ||
        normalizedName.endsWith(` ${normalizedAlias}`) ||
        normalizedName.includes(` ${normalizedAlias} `);
    }),
  ) ?? null;
}

export function matchWaystarPayerByPortalName(portalPayerName: string): WaystarPayerHandler | null {
  const normalizedPortalName = normalizeLookupValue(portalPayerName);
  if (!normalizedPortalName) return null;

  return Object.values(waystarPayerRegistry).find((payer) => {
    const registeredPortalName = normalizeLookupValue(payer.portalPayerName);
    return registeredPortalName === normalizedPortalName ||
      registeredPortalName.startsWith(`${normalizedPortalName} `) ||
      normalizedPortalName.startsWith(`${registeredPortalName} `);
  }) ?? null;
}

function normalizeLookupValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}


