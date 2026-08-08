import { UnknownPortalError } from "../../../../../core/errors";
import { uhcWellmedPayerConfig } from "./uhc-wellmed/config";

export const uhcEligibilityPayerRegistry = {
  "uhc-wellmed": uhcWellmedPayerConfig,
  "aarp-medicare-advantage-wellmed": {
    id: "aarp-medicare-advantage-wellmed",
    name: "AARP Medicare Advantage Wellmed",
  },
  "united-healthcare-dual-complete": {
    id: "united-healthcare-dual-complete",
    name: "United Healthcare Dual Complete",
  },
} as const;

export function getUhcEligibilityPayer(payerId: string) {
  const payer = uhcEligibilityPayerRegistry[
    payerId as keyof typeof uhcEligibilityPayerRegistry
  ];
  if (!payer) throw new UnknownPortalError(`uhc/${payerId}`);
  return payer;
}
