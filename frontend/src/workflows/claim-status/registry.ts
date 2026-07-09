import { aerialFrontendPortalConfig } from "./portals/aerial/portal-config";
import { availityFrontendPortalConfig } from "./portals/availity/portal-config";
import { blueShieldFrontendPortalConfig } from "./portals/blue-shield/portal-config";
import { iehpFrontendPortalConfig } from "./portals/iehp/portal-config";
import { regalFrontendPortalConfig } from "./portals/regal/portal-config";

export {
  aerialFrontendPortalConfig,
  availityFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  iehpFrontendPortalConfig,
  regalFrontendPortalConfig,
};

export const claimStatusPortalRegistry = [
  iehpFrontendPortalConfig,
  aerialFrontendPortalConfig,
  regalFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  availityFrontendPortalConfig,
] as const;
