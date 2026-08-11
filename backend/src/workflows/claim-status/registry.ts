import { UnknownPortalError } from "../../core/errors";
import type { PortalScraper } from "./types";
import type { AutomationRunner } from "../types";

type PortalScraperLoader = () => Promise<PortalScraper>;

const claimStatusPortalLoaders = {
  aerial: async () => (await import("./portals/aerial/scraper")).aerialScraper,
  "all-care": async () => (await import("./portals/all-care/scraper")).allCareScraper,
  astrona: async () => (await import("./portals/astrona/scraper")).astronaScraper,
  availity: async () => (await import("./portals/availity/scraper")).availityScraper,
  "blue-shield": async () => (await import("./portals/blue-shield/scraper")).blueShieldScraper,
  iehp: async () => (await import("./portals/iehp/scraper")).iehpScraper,
  "optum-pro": async () => (await import("../../scrapers/optum-pro/scraper")).optumProScraper,
  regal: async () => (await import("./portals/regal/scraper")).regalScraper,
  uhc: async () => (await import("./portals/uhc/scraper")).uhcScraper,
} satisfies Record<string, PortalScraperLoader>;

const claimStatusPortalNames = {
  aerial: "Aerial Care Claim Status",
  "all-care": "All Care Claim Status",
  astrona: "Astrona Claim Status",
  availity: "Availity Claim Status",
  "blue-shield": "Blue Shield Claim Status",
  iehp: "IEHP Claim Status",
  "optum-pro": "Optum Pro Claim Status",
  regal: "Regal Claim Status",
  uhc: "UHC Claim Status",
} satisfies Record<keyof typeof claimStatusPortalLoaders, string>;

export async function getClaimStatusScraper(portalId: string): Promise<PortalScraper> {
  const loadScraper = claimStatusPortalLoaders[
    portalId as keyof typeof claimStatusPortalLoaders
  ];
  if (!loadScraper) throw new UnknownPortalError(portalId);
  return loadScraper();
}

export function getClaimStatusRunner(portalId: string): AutomationRunner {
  if (!(portalId in claimStatusPortalLoaders)) throw new UnknownPortalError(portalId);
  return {
    workflowId: "claim-status",
    portalId,
    name: claimStatusPortalNames[portalId as keyof typeof claimStatusPortalNames],
    validateInput: (input) => input,
    run: async (input, context) => {
      const scraper = await getClaimStatusScraper(portalId);
      await scraper.run(scraper.validateInput(input), context);
    },
  };
}

export function listClaimStatusPortals() {
  return Object.keys(claimStatusPortalLoaders).map((id) => ({
    id,
    name: claimStatusPortalNames[id as keyof typeof claimStatusPortalNames],
  }));
}
