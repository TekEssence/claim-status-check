import type { PortalConfig } from "../../types";

export const uhcConfig = {
  id: "uhc",
  name: "UHC Claim Status",
  runtime: {
    supportsLocal: true,
    supportsDeployed: false,
    requiresVpn: false,
  },
} satisfies PortalConfig;
