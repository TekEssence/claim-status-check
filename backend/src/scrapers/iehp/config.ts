import type { PortalConfig } from "../types";

export const iehpConfig = {
  id: "iehp",
  name: "IEHP Claim Status",
  runtime: {
    supportsLocal: true,
    supportsDeployed: true,
    requiresVpn: false,
  },
} satisfies PortalConfig;
