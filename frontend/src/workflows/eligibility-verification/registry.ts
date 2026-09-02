import { availityEligibilityFrontendPortalConfig } from "./portals/availity/portal-config";
import { uhcEligibilityFrontendPortalConfig } from "./portals/uhc/portal-config";
import { waystarFrontendPortalConfig } from "./portals/waystar/portal-config";
import { noridianEligibilityFrontendPortalConfig } from "./portals/noridian/portal-config";

export type EligibilityPortalConfig =
  | typeof availityEligibilityFrontendPortalConfig
  | typeof uhcEligibilityFrontendPortalConfig
  | typeof waystarFrontendPortalConfig
  | typeof noridianEligibilityFrontendPortalConfig;

export const eligibilityPortals: readonly EligibilityPortalConfig[] = [
  waystarFrontendPortalConfig,
  availityEligibilityFrontendPortalConfig,
  uhcEligibilityFrontendPortalConfig,
  noridianEligibilityFrontendPortalConfig,
];

export function getEligibilityPortalsForProject(projectId: "minimax" | "medrevenue") {
  return eligibilityPortals.filter((portal) => (portal.projects as readonly string[]).includes(projectId));
}

export function getEligibilityPortal(portalId: string | null) {
  return eligibilityPortals.find((portal) => portal.id === portalId) ?? null;
}
