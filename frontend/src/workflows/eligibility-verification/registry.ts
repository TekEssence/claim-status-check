import { availityEligibilityFrontendPortalConfig } from "./portals/availity/portal-config";
import { uhcEligibilityFrontendPortalConfig } from "./portals/uhc/portal-config";
import { waystarFrontendPortalConfig } from "./portals/waystar/portal-config";

export type EligibilityPortalConfig =
  | typeof availityEligibilityFrontendPortalConfig
  | typeof uhcEligibilityFrontendPortalConfig
  | typeof waystarFrontendPortalConfig;

export const eligibilityPortals: readonly EligibilityPortalConfig[] = [
  waystarFrontendPortalConfig,
  availityEligibilityFrontendPortalConfig,
  uhcEligibilityFrontendPortalConfig,
];

export function getEligibilityPortal(portalId: string | null) {
  return eligibilityPortals.find((portal) => portal.id === portalId) ?? null;
}
