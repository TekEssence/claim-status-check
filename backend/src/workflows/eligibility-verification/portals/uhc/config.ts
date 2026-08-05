import { uhcEligibilityPayerRegistry } from "./payers/registry";

export const uhcEligibilityPortalConfig = {
  id: "uhc",
  name: "UHC Eligibility Verification",
  payers: uhcEligibilityPayerRegistry,
} as const;
