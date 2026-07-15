import { aerialFrontendPortalConfig } from "./portals/aerial/portal-config";
import { availityFrontendPortalConfig } from "./portals/availity/portal-config";
import { blueShieldFrontendPortalConfig } from "./portals/blue-shield/portal-config";
import { iehpFrontendPortalConfig } from "./portals/iehp/portal-config";
import { kaiserFrontendPortalConfig } from "./portals/kaiser/portal-config";
import { optumProFrontendPortalConfig } from "./portals/optum-pro/portal-config";
import { regalFrontendPortalConfig } from "./portals/regal/portal-config";

export {
  aerialFrontendPortalConfig,
  availityFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  iehpFrontendPortalConfig,
  kaiserFrontendPortalConfig,
  optumProFrontendPortalConfig,
  regalFrontendPortalConfig,
};

export const claimStatusPortalRegistry = [
  iehpFrontendPortalConfig,
  aerialFrontendPortalConfig,
  regalFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  availityFrontendPortalConfig,
  kaiserFrontendPortalConfig,
  optumProFrontendPortalConfig,
] as const;
