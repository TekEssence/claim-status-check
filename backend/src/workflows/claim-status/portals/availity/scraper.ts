import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { availityConfig } from "./config";
import { runAvailityClaimStatusJob } from "./claim-status-job";

export type AvailityScraperInput = FormData;

class AvailityScraper extends BaseScraper<AvailityScraperInput> {
  id = availityConfig.id;
  name = availityConfig.name;
  config = availityConfig;

  validateInput(input: unknown): AvailityScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("Availity scraper input must be FormData.");
    }
    return input;
  }

  async run(input: AvailityScraperInput, context: ScraperContext): Promise<void> {
    await runAvailityClaimStatusJob(input, context);
  }
}

export const availityScraper = new AvailityScraper();
