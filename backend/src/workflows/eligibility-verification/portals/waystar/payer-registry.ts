import { UnknownPortalError } from "../../../../core/errors";
import { arpPayer } from "./payers/arp";
import { aetnaMedicarePpoPayer } from "./payers/aetna-medicare-ppo";
import { amerigroupWellpointPayer } from "./payers/amerigroup";
import { bayCarePlusMedicareAdvantagePayer } from "./payers/baycare-plus-medicare-advantage";
import {
  blueCrossBlueShieldFloridaPayer,
  blueCrossBlueShieldTexasPayer,
} from "./payers/blue-cross-blue-shield";
import { medicarePayer } from "./payers/medicare";
import type { WaystarPayerHandler } from "./payers/types";

export const waystarPayerRegistry = {
  medicare: medicarePayer,
  arp: arpPayer,
  "aetna-medicare-ppo": aetnaMedicarePpoPayer,
  "amerigroup-wellpoint": amerigroupWellpointPayer,
  "baycare-plus-medicare-advantage": bayCarePlusMedicareAdvantagePayer,
  "blue-cross-blue-shield-texas": blueCrossBlueShieldTexasPayer,
  "blue-cross-blue-shield-florida": blueCrossBlueShieldFloridaPayer,
} satisfies Record<string, WaystarPayerHandler>;

export function getWaystarPayer(payerId: string): WaystarPayerHandler {
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

  return Object.values(waystarPayerRegistry).find(
    (payer) => normalizeLookupValue(payer.portalPayerName) === normalizedPortalName,
  ) ?? null;
}

function normalizeLookupValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
