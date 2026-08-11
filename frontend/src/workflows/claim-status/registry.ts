import { aerialFrontendPortalConfig } from "./portals/aerial/portal-config";
import { astronaFrontendPortalConfig } from "./portals/astrona/portal-config";
import { allCareFrontendPortalConfig } from "./portals/all-care/portal-config";
import { availityFrontendPortalConfig } from "./portals/availity/portal-config";
import { blueShieldFrontendPortalConfig } from "./portals/blue-shield/portal-config";
import { iehpFrontendPortalConfig } from "./portals/iehp/portal-config";
import { regalFrontendPortalConfig } from "./portals/regal/portal-config";
import { uhcFrontendPortalConfig } from "./portals/uhc/portal-config";
import { optumProFrontendPortalConfig } from "../../portals/optum-pro/portal-config";

export {
  aerialFrontendPortalConfig,
  allCareFrontendPortalConfig,
  astronaFrontendPortalConfig,
  availityFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  iehpFrontendPortalConfig,
  optumProFrontendPortalConfig,
  regalFrontendPortalConfig,
  uhcFrontendPortalConfig,
};

export const claimStatusPortalRegistry = [
  iehpFrontendPortalConfig,
  allCareFrontendPortalConfig,
  aerialFrontendPortalConfig,
  astronaFrontendPortalConfig,
  regalFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  uhcFrontendPortalConfig,
  availityFrontendPortalConfig,
  optumProFrontendPortalConfig,
] as const;
