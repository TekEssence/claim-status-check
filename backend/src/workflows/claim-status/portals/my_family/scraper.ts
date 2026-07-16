import { BaseScraper } from "../../base";
import type { ScraperContext } from "../../types";
import { runMyFamilyClaimStatusJob } from "./claim-status-job";
import { myFamilyConfig } from "./config";

export type MyFamilyScraperInput = FormData;

class MyFamilyScraper extends BaseScraper<MyFamilyScraperInput> {
  id = myFamilyConfig.id;
  name = myFamilyConfig.name;
  config = myFamilyConfig;

  validateInput(input: unknown): MyFamilyScraperInput {
    if (!(input instanceof FormData)) throw new Error("My family scraper input must be FormData.");
    return input;
  }

  async run(input: MyFamilyScraperInput, context: ScraperContext): Promise<void> {
    await runMyFamilyClaimStatusJob(input, context);
  }
}

export const myFamilyScraper = new MyFamilyScraper();
