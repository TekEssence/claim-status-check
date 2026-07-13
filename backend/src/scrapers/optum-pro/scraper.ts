import { BaseScraper } from "../../workflows/claim-status/base";
import type { ScraperContext } from "../../workflows/claim-status/types";
import { optumProConfig } from "./config";
import { runOptumProLoginJob } from "./login-job";

export type OptumProScraperInput = FormData;

class OptumProScraper extends BaseScraper<OptumProScraperInput> {
  id = optumProConfig.id;
  name = optumProConfig.name;
  config = optumProConfig;

  validateInput(input: unknown): OptumProScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("Optum Pro scraper input must be FormData.");
    }
    return input;
  }

  async run(input: OptumProScraperInput, context: ScraperContext): Promise<void> {
    await runOptumProLoginJob(input, context);
  }
}

export const optumProScraper = new OptumProScraper();
