import { UnknownPortalError } from "../../../../../core/errors";
import { aetnaMedicareAvailityEligibilityPayer } from "./aetna-medicare";
import { bcbsAvailityEligibilityPayer } from "./bcbs";
import { humanaAvailityEligibilityPayer } from "./humana";
import { vanLangIpaAvailityEligibilityPayer } from "./van-lang-ipa";
import { wellcareAvailityEligibilityPayer } from "./wellcare";
import type { AvailityEligibilityPayerHandler } from "./types";

export const availityEligibilityPayerRegistry = {
  "aetna-medicare": aetnaMedicareAvailityEligibilityPayer,
  bcbs: bcbsAvailityEligibilityPayer,
  humana: humanaAvailityEligibilityPayer,
  "van-lang-ipa": vanLangIpaAvailityEligibilityPayer,
  amerigroup: vanLangIpaAvailityEligibilityPayer,
  wellpoint: vanLangIpaAvailityEligibilityPayer,
  wellcare: wellcareAvailityEligibilityPayer,
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
