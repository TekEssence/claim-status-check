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
  "united-health-care": {
    id: "united-health-care",
    name: "United Health Care",
  },
  "uhc-medicare-advantage": {
    id: "uhc-medicare-advantage",
    name: "UHC Medicare Advantage",
  },
  "united-health-care-of-all-states": {
    id: "united-health-care-of-all-states",
    name: "United Health Care Of All States",
  },
  "united-health-choice-plus-network": {
    id: "united-health-choice-plus-network",
    name: "United Health Choice Plus Network",
  },
  "uhc": {
    id: "uhc",
    name: "UHC",
  },
  "united-healthcare-community-plan-tx": {
    id: "united-healthcare-community-plan-tx",
    name: "United Healthcare Community Plan TX",
  },
  "united-healthcare": {
    id: "united-healthcare",
    name: "United Healthcare",
  },
} as const;

export function getUhcEligibilityPayer(payerId: string) {
  const payer = uhcEligibilityPayerRegistry[
    payerId as keyof typeof uhcEligibilityPayerRegistry
  ];
  if (!payer) throw new UnknownPortalError(`uhc/${payerId}`);
  return payer;
}
