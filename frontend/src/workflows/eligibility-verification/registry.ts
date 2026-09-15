import { medicalEligibilityFrontendPortalConfig } from "./portals/medi-cal/portal-config";
import { healthnetEligibilityFrontendPortalConfig } from "./portals/healthnet/portal-config";
import { iehpEligibilityFrontendPortalConfig } from "./portals/iehp/portal-config";
import { availityEligibilityFrontendPortalConfig } from "./portals/availity/portal-config";
import { uhcEligibilityFrontendPortalConfig } from "./portals/uhc/portal-config";
import { waystarFrontendPortalConfig } from "./portals/waystar/portal-config";
import { noridianEligibilityFrontendPortalConfig } from "./portals/noridian/portal-config";
import { triZettoEligibilityFrontendPortalConfig } from "./portals/trizetto/portal-config";

export type EligibilityPortalConfig =
  | typeof medicalEligibilityFrontendPortalConfig
  | typeof availityEligibilityFrontendPortalConfig
  | typeof uhcEligibilityFrontendPortalConfig
  | typeof waystarFrontendPortalConfig
  | typeof noridianEligibilityFrontendPortalConfig
  | typeof healthnetEligibilityFrontendPortalConfig
  | typeof iehpEligibilityFrontendPortalConfig
  | typeof triZettoEligibilityFrontendPortalConfig;

export const eligibilityPortals: readonly EligibilityPortalConfig[] = [
  medicalEligibilityFrontendPortalConfig,
  waystarFrontendPortalConfig,
  availityEligibilityFrontendPortalConfig,
  uhcEligibilityFrontendPortalConfig,
  noridianEligibilityFrontendPortalConfig,
  healthnetEligibilityFrontendPortalConfig,
  iehpEligibilityFrontendPortalConfig,
  triZettoEligibilityFrontendPortalConfig,
];

export function getEligibilityPortalsForProject(projectId: "minimax" | "medrevenue") {
  return eligibilityPortals.filter((portal) => (portal.projects as readonly string[]).includes(projectId));
}

export function getEligibilityPortal(portalId: string | null) {
  return eligibilityPortals.find((portal) => portal.id === portalId) ?? null;
}
