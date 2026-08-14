import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { medpointConfig } from "./config";
import { runMedpointLoginHandoffJob } from "./login-job";

export type MedpointScraperInput = FormData;

class MedpointScraper extends BaseScraper<MedpointScraperInput> {
  id = medpointConfig.id;
  name = medpointConfig.name;
  config = medpointConfig;

  validateInput(input: unknown): MedpointScraperInput {
    if (!(input instanceof FormData)) {
      throw new Error("Medpoint scraper input must be FormData.");
    }
    return input;
  }

  async run(input: MedpointScraperInput, context: ScraperContext): Promise<void> {
    await runMedpointLoginHandoffJob(input, context);
  }
}

export const medpointScraper = new MedpointScraper();
