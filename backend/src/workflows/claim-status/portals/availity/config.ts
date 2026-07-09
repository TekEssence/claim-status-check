import type { PortalConfig } from "../../types";

export const availityConfig = {
  id: "availity",
  name: "Availity Claim Status",
  runtime: {
    supportsLocal: true,
    supportsDeployed: false,
    requiresVpn: false,
  },
} satisfies PortalConfig;

export const AVAILITY_AVAILABLE_PAYERS = ["Aetna", "Blue Cross Blue Shield"] as const;
