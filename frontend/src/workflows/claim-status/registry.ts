import { aerialFrontendPortalConfig } from "./portals/aerial/portal-config";
import { availityFrontendPortalConfig } from "./portals/availity/portal-config";
import { blueShieldFrontendPortalConfig } from "./portals/blue-shield/portal-config";
import { cignaFrontendPortalConfig } from "./portals/cigna/portal-config";
import { iehpFrontendPortalConfig } from "./portals/iehp/portal-config";
import { kaiserFrontendPortalConfig } from "./portals/kaiser/portal-config";
import { myFamilyFrontendPortalConfig } from "./portals/my_family/portal-config";
import { optumProFrontendPortalConfig } from "./portals/optum-pro/portal-config";
import { regalFrontendPortalConfig } from "./portals/regal/portal-config";

export {
  aerialFrontendPortalConfig,
  availityFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  cignaFrontendPortalConfig,
  iehpFrontendPortalConfig,
  kaiserFrontendPortalConfig,
  myFamilyFrontendPortalConfig,
  optumProFrontendPortalConfig,
  regalFrontendPortalConfig,
};

export const claimStatusPortalRegistry = [
  iehpFrontendPortalConfig,
  aerialFrontendPortalConfig,
  regalFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  cignaFrontendPortalConfig,
  availityFrontendPortalConfig,
  kaiserFrontendPortalConfig,
  myFamilyFrontendPortalConfig,
  optumProFrontendPortalConfig,
] as const;
