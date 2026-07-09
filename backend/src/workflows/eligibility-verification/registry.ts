import { UnknownPortalError } from "../../core/errors";
import type { AutomationRunner } from "../types";
import { createWaystarRunner } from "./portals/waystar/scraper";

export const eligibilityPortalRegistry = {
  waystar: createWaystarRunner,
} satisfies Record<string, () => AutomationRunner>;

export function getEligibilityRunner(
  portalId: string,
): AutomationRunner {
  const factory = eligibilityPortalRegistry[
    portalId as keyof typeof eligibilityPortalRegistry
  ];
  if (!factory) throw new UnknownPortalError(portalId);
  return factory();
}
