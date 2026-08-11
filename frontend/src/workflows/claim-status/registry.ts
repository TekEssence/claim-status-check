import { aerialFrontendPortalConfig } from "./portals/aerial/portal-config";
import { astronaFrontendPortalConfig } from "./portals/astrona/portal-config";
import { allCareFrontendPortalConfig } from "./portals/all-care/portal-config";
import { availityFrontendPortalConfig } from "./portals/availity/portal-config";
import { blueShieldFrontendPortalConfig } from "./portals/blue-shield/portal-config";
import { cignaFrontendPortalConfig } from "./portals/cigna/portal-config";
import { iehpFrontendPortalConfig } from "./portals/iehp/portal-config";
import { kaiserFrontendPortalConfig } from "./portals/kaiser/portal-config";
import { myFamilyFrontendPortalConfig } from "./portals/my_family/portal-config";
import { optumProFrontendPortalConfig } from "./portals/optum-pro/portal-config";
import { physiciansFrontendPortalConfig } from "./portals/physicians/portal-config";
import { regalFrontendPortalConfig } from "./portals/regal/portal-config";
import { uhcFrontendPortalConfig } from "./portals/uhc/portal-config";

export {
  aerialFrontendPortalConfig,
  allCareFrontendPortalConfig,
  astronaFrontendPortalConfig,
  availityFrontendPortalConfig,
  blueShieldFrontendPortalConfig,
  cignaFrontendPortalConfig,
  iehpFrontendPortalConfig,
  kaiserFrontendPortalConfig,
  myFamilyFrontendPortalConfig,
  optumProFrontendPortalConfig,
  physiciansFrontendPortalConfig,
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
  cignaFrontendPortalConfig,
  availityFrontendPortalConfig,
  kaiserFrontendPortalConfig,
  myFamilyFrontendPortalConfig,
  physiciansFrontendPortalConfig,
  optumProFrontendPortalConfig,
] as const;
