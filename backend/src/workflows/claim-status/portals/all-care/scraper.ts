import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { runAllCareClaimStatusJob } from "./claim-status-job";
import { allCareConfig } from "./config";

class AllCareScraper extends BaseScraper<FormData> {
  id = allCareConfig.id;
  name = allCareConfig.name;
  config = allCareConfig;
  validateInput(input: unknown): FormData {
    if (!(input instanceof FormData)) throw new Error("AllCare scraper input must be FormData.");
    return input;
  }
  async run(input: FormData, context: ScraperContext): Promise<void> {
    await runAllCareClaimStatusJob(input, context);
  }
}

export const allCareScraper = new AllCareScraper();
