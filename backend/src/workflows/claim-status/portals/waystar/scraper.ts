import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { waystarConfig } from "./config";
import { runWaystarClaimStatusJob } from "./claim-status-job";

export type WaystarScraperInput = FormData;

class WaystarScraper extends BaseScraper<WaystarScraperInput> {
  id = waystarConfig.id;
  name = waystarConfig.name;
  config = waystarConfig;

  validateInput(input: unknown): WaystarScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("Waystar scraper input must be FormData.");
    }
    return input;
  }

  async run(input: WaystarScraperInput, context: ScraperContext): Promise<void> {
    await runWaystarClaimStatusJob(input, context);
  }
}

export const waystarScraper = new WaystarScraper();
