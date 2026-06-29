import { BaseScraper } from "../base";
import type { ScraperContext } from "../types";
import { blueShieldConfig } from "./config";
import { runBlueShieldClaimStatusJob } from "./claim-status-job";

export type BlueShieldScraperInput = FormData;

class BlueShieldScraper extends BaseScraper<BlueShieldScraperInput> {
  id = blueShieldConfig.id;
  name = blueShieldConfig.name;
  config = blueShieldConfig;

  validateInput(input: unknown): BlueShieldScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("Blue Shield scraper input must be FormData.");
    }
    return input;
  }

  async run(input: BlueShieldScraperInput, context: ScraperContext): Promise<void> {
    await runBlueShieldClaimStatusJob(input, context);
  }
}

export const blueShieldScraper = new BlueShieldScraper();
