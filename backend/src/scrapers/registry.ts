import { aerialScraper } from "./aerial/scraper";
import { blueShieldScraper } from "./blue-shield/scraper";
import { iehpScraper } from "./iehp/scraper";
import { UnknownPortalError } from "../core/errors";
import type { PortalScraper } from "./types";

export const scraperRegistry = {
  aerial: aerialScraper,
  "blue-shield": blueShieldScraper,
  iehp: iehpScraper,
} satisfies Record<string, PortalScraper>;

export function getScraper(portalId: string): PortalScraper {
  const scraper = scraperRegistry[portalId as keyof typeof scraperRegistry];
  if (!scraper) {
    throw new UnknownPortalError(portalId);
  }
  return scraper;
}

export function listScrapers(): PortalScraper[] {
  return Object.values(scraperRegistry);
}
