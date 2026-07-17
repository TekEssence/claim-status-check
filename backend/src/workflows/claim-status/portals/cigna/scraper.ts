import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { cignaConfig } from "./config";
import { runCignaClaimStatusJob } from "./claim-status-job";

export type CignaScraperInput = FormData;

class CignaScraper extends BaseScraper<CignaScraperInput> {
  id = cignaConfig.id;
  name = cignaConfig.name;
  config = cignaConfig;

  validateInput(input: unknown): CignaScraperInput {
    if (!(input instanceof FormData)) throw new Error("Cigna scraper input must be FormData.");
    return input;
  }

  async run(input: CignaScraperInput, context: ScraperContext): Promise<void> {
    await runCignaClaimStatusJob(input, context);
  }
}

export const cignaScraper = new CignaScraper();
