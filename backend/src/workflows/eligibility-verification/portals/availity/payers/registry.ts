import { UnknownPortalError } from "../../../../../core/errors";
import { bcbsAvailityEligibilityPayer } from "./bcbs";
import type { AvailityEligibilityPayerHandler } from "./types";

export const availityEligibilityPayerRegistry = {
  bcbs: bcbsAvailityEligibilityPayer,
} satisfies Record<string, AvailityEligibilityPayerHandler>;

export function getAvailityEligibilityPayer(
  payerId: string,
): AvailityEligibilityPayerHandler {
  const payer = availityEligibilityPayerRegistry[
    payerId as keyof typeof availityEligibilityPayerRegistry
  ];
  if (!payer) throw new UnknownPortalError(`availity/${payerId}`);
  return payer;
}
