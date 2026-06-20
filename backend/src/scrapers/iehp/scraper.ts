import { BaseScraper } from "../base";
import type { ScraperContext } from "../types";
import { iehpConfig } from "./config";

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
    void input;
    void context;
    throw new Error("IEHP scraper execution still lives in the existing process-claims route during phase 1.");
  }
}

export const iehpScraper = new IehpScraper();
