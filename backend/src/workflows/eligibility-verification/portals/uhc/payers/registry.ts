import { UnknownPortalError } from "../../../../../core/errors";
import { uhcWellmedPayerConfig } from "./uhc-wellmed/config";

export const uhcEligibilityPayerRegistry = {
  "uhc-wellmed": uhcWellmedPayerConfig,
} as const;

export function getUhcEligibilityPayer(payerId: string) {
  const payer = uhcEligibilityPayerRegistry[
    payerId as keyof typeof uhcEligibilityPayerRegistry
  ];
  if (!payer) throw new UnknownPortalError(`uhc/${payerId}`);
  return payer;
}
