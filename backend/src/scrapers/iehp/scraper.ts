import { BaseScraper } from "../base";
import type { ScraperContext } from "../types";
import { iehpConfig } from "./config";
import { runProcessClaimsJob } from "./process-claims-job";

export type IehpScraperInput = FormData;

class IehpScraper extends BaseScraper<IehpScraperInput> {
  id = iehpConfig.id;
  name = iehpConfig.name;
  config = iehpConfig;

  validateInput(input: unknown): IehpScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("IEHP scraper input must be FormData.");
    }
    return input;
  }

  async run(input: IehpScraperInput, context: ScraperContext): Promise<void> {
    await runProcessClaimsJob(context.jobId, input);
  }
}

export const iehpScraper = new IehpScraper();
