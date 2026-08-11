import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { runAstronaClaimStatusJob } from "./claim-status-job";
import { astronaConfig } from "./config";

class AstronaScraper extends BaseScraper<FormData> {
  id = astronaConfig.id;
  name = astronaConfig.name;
  config = astronaConfig;
  validateInput(input: unknown): FormData {
    if (!(input instanceof FormData)) throw new Error("Astrona scraper input must be FormData.");
    return input;
  }
  async run(input: FormData, context: ScraperContext): Promise<void> {
    await runAstronaClaimStatusJob(input, context);
  }
}

export const astronaScraper = new AstronaScraper();
