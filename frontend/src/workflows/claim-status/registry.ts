import { aerialFrontendPortalConfig } from "./portals/aerial/portal-config";
import { availityFrontendPortalConfig } from "./portals/availity/portal-config";
import { blueShieldFrontendPortalConfig } from "./portals/blue-shield/portal-config";
import { iehpFrontendPortalConfig } from "./portals/iehp/portal-config";
import { regalFrontendPortalConfig } from "./portals/regal/portal-config";
import { waystarFrontendPortalConfig } from "./portals/waystar/portal-config";
import { optumProFrontendPortalConfig } from "../../portals/optum-pro/portal-config";

export {
  aerialFrontendPortalConfig,
  availityFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  iehpFrontendPortalConfig,
  optumProFrontendPortalConfig,
  regalFrontendPortalConfig,
  waystarFrontendPortalConfig,
};

export const claimStatusPortalRegistry = [
  iehpFrontendPortalConfig,
  aerialFrontendPortalConfig,
  regalFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  availityFrontendPortalConfig,
  waystarFrontendPortalConfig,
  optumProFrontendPortalConfig,
] as const;
