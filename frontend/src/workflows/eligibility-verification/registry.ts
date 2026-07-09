import { waystarFrontendPortalConfig } from "./portals/waystar/portal-config";

export type EligibilityPortalConfig = typeof waystarFrontendPortalConfig;

export const eligibilityPortals: readonly EligibilityPortalConfig[] = [
  waystarFrontendPortalConfig,
];

export function getEligibilityPortal(portalId: string | null) {
  return eligibilityPortals.find((portal) => portal.id === portalId) ?? null;
}
