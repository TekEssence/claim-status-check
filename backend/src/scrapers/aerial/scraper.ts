import { BaseScraper } from "../base";
import type { ScraperContext } from "../types";
import { aerialConfig } from "./config";
import { runAerialClaimStatusJob } from "./claim-status-job";

export type AerialScraperInput = FormData;

class AerialScraper extends BaseScraper<AerialScraperInput> {
  id = aerialConfig.id;
  name = aerialConfig.name;
  config = aerialConfig;

  validateInput(input: unknown): AerialScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("Aerial scraper input must be FormData.");
    }
    return input;
  }

  async run(input: AerialScraperInput, context: ScraperContext): Promise<void> {
    await runAerialClaimStatusJob(input, context);
  }
}

export const aerialScraper = new AerialScraper();
