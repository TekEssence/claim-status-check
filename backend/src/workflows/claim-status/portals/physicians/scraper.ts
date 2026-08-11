import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { runPhysiciansClaimStatusJob } from "./claim-status-job";
import { physiciansConfig } from "./config";

export type PhysiciansScraperInput = FormData;

class PhysiciansScraper extends BaseScraper<PhysiciansScraperInput> {
  id = physiciansConfig.id;
  name = physiciansConfig.name;
  config = physiciansConfig;

  validateInput(input: unknown): PhysiciansScraperInput {
    if (!(input instanceof FormData)) throw new Error("Physicians scraper input must be FormData.");
    return input;
  }

  async run(input: PhysiciansScraperInput, context: ScraperContext): Promise<void> {
    await runPhysiciansClaimStatusJob(input, context);
  }
}

export const physiciansScraper = new PhysiciansScraper();
