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

export const AVAILITY_AVAILABLE_PAYERS = ["Aetna", "Anthem-CA", "Blue Cross Blue Shield", "Wellpoint", "Wellcare", "Humana", "Molina"] as const;
