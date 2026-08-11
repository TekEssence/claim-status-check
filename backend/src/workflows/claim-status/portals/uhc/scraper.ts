import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { uhcConfig } from "./config";
import { runUhcClaimStatusJob } from "./claim-status-job";

export type UhcScraperInput = FormData;

class UhcScraper extends BaseScraper<UhcScraperInput> {
  id = uhcConfig.id;
  name = uhcConfig.name;
  config = uhcConfig;

  validateInput(input: unknown): UhcScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("UHC scraper input must be FormData.");
    }
    return input;
  }

  async run(input: UhcScraperInput, context: ScraperContext): Promise<void> {
    await runUhcClaimStatusJob(input, context);
  }
}

export const uhcScraper = new UhcScraper();
