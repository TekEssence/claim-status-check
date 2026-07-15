import { UnknownPortalError } from "../../core/errors";
import { aerialScraper } from "./portals/aerial/scraper";
import { availityScraper } from "./portals/availity/scraper";
import { blueShieldScraper } from "./portals/blue-shield/scraper";
import { iehpScraper } from "./portals/iehp/scraper";
import { kaiserScraper } from "./portals/kaiser/scraper";
import { regalScraper } from "./portals/regal/scraper";
import { optumProScraper } from "../../scrapers/optum-pro/scraper";
import type { PortalScraper } from "./types";
import type { AutomationRunner } from "../types";

export const claimStatusPortalRegistry = {
  aerial: aerialScraper,
  availity: availityScraper,
  "blue-shield": blueShieldScraper,
  iehp: iehpScraper,
  kaiser: kaiserScraper,
  "optum-pro": optumProScraper,
  regal: regalScraper,
} satisfies Record<string, PortalScraper>;

export function getClaimStatusScraper(portalId: string): PortalScraper {
  const scraper = claimStatusPortalRegistry[
    portalId as keyof typeof claimStatusPortalRegistry
  ];
  if (!scraper) throw new UnknownPortalError(portalId);
  return scraper;
}

export function getClaimStatusRunner(portalId: string): AutomationRunner {
  const scraper = getClaimStatusScraper(portalId);
  return {
    workflowId: "claim-status",
    portalId,
    name: scraper.name,
    validateInput: (input) => scraper.validateInput(input),
    run: (input, context) => scraper.run(input, context),
  };
}

export function listClaimStatusPortals() {
  return Object.values(claimStatusPortalRegistry).map((scraper) => ({
    id: scraper.id,
    name: scraper.name,
  }));
}
