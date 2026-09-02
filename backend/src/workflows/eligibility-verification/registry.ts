import { UnknownPortalError } from "../../core/errors";
import type { AutomationRunner } from "../types";
import { createAvailityEligibilityRunner } from "./portals/availity/scraper";
import { createUhcEligibilityRunner } from "./portals/uhc/scraper";
import { createWaystarRunner } from "./portals/waystar/scraper";
import { createNoridianEligibilityRunner } from "./portals/noridian/scraper";

export const eligibilityPortalRegistry = {
  availity: createAvailityEligibilityRunner,
  uhc: createUhcEligibilityRunner,
  waystar: createWaystarRunner,
  noridian: createNoridianEligibilityRunner,
} satisfies Record<string, (payerId?: string) => AutomationRunner>;

export function getEligibilityRunner(
  portalId: string,
  payerId?: string,
): AutomationRunner {
  const factory = eligibilityPortalRegistry[
    portalId as keyof typeof eligibilityPortalRegistry
  ];
  if (!factory) throw new UnknownPortalError(portalId);
  return factory(payerId);
}
