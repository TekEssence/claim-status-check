import { aerialFrontendPortalConfig } from "./portals/aerial/portal-config";
import { astronaFrontendPortalConfig } from "./portals/astrona/portal-config";
import { availityFrontendPortalConfig } from "./portals/availity/portal-config";
import { blueShieldFrontendPortalConfig } from "./portals/blue-shield/portal-config";
import { iehpFrontendPortalConfig } from "./portals/iehp/portal-config";
import { regalFrontendPortalConfig } from "./portals/regal/portal-config";
import { optumProFrontendPortalConfig } from "../../portals/optum-pro/portal-config";

export {
  aerialFrontendPortalConfig,
  astronaFrontendPortalConfig,
  availityFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  iehpFrontendPortalConfig,
  optumProFrontendPortalConfig,
  regalFrontendPortalConfig,
};

export const claimStatusPortalRegistry = [
  iehpFrontendPortalConfig,
  aerialFrontendPortalConfig,
  astronaFrontendPortalConfig,
  regalFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  availityFrontendPortalConfig,
  optumProFrontendPortalConfig,
] as const;
