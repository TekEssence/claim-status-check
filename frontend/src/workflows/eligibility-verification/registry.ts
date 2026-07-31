import { availityEligibilityFrontendPortalConfig } from "./portals/availity/portal-config";
import { waystarFrontendPortalConfig } from "./portals/waystar/portal-config";

export type EligibilityPortalConfig = typeof availityEligibilityFrontendPortalConfig | typeof waystarFrontendPortalConfig;

export const eligibilityPortals: readonly EligibilityPortalConfig[] = [
  waystarFrontendPortalConfig,
  availityEligibilityFrontendPortalConfig,
];

export function getEligibilityPortal(portalId: string | null) {
  return eligibilityPortals.find((portal) => portal.id === portalId) ?? null;
}
