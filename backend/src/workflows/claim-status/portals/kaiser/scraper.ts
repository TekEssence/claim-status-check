import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { kaiserConfig } from "./config";
import { runKaiserClaimStatusJob } from "./claim-status-job";

export type KaiserScraperInput = FormData;

class KaiserScraper extends BaseScraper<KaiserScraperInput> {
  id = kaiserConfig.id;
  name = kaiserConfig.name;
  config = kaiserConfig;

  validateInput(input: unknown): KaiserScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("Kaiser scraper input must be FormData.");
    }
    return input;
  }

  async run(input: KaiserScraperInput, context: ScraperContext): Promise<void> {
    await runKaiserClaimStatusJob(input, context);
  }
}

export const kaiserScraper = new KaiserScraper();
