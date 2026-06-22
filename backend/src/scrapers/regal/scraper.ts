import { BaseScraper } from "../base";
import type { ScraperContext } from "../types";
import { regalConfig } from "./config";
import { runRegalLoginJob } from "./login-job";

export type RegalScraperInput = FormData;

class RegalScraper extends BaseScraper<RegalScraperInput> {
  id = regalConfig.id;
  name = regalConfig.name;
  config = regalConfig;

  validateInput(input: unknown): RegalScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("Regal scraper input must be FormData.");
    }
    return input;
  }

  async run(input: RegalScraperInput, context: ScraperContext): Promise<void> {
    await runRegalLoginJob(input, context);
  }
}

export const regalScraper = new RegalScraper();
