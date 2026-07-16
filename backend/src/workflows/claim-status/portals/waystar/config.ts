import type { PortalConfig } from "../../types";

export const waystarConfig = {
  id: "waystar",
  name: "Waystar Claim Status",
  runtime: {
    supportsLocal: true,
    supportsDeployed: false,
    requiresVpn: false,
  },
} satisfies PortalConfig;
