import type { PortalConfig, PortalScraper, ScraperContext } from "./types";

export abstract class BaseScraper<TInput = unknown> implements PortalScraper<TInput> {
  abstract id: string;
  abstract name: string;
  abstract config: PortalConfig;

  abstract validateInput(input: unknown): TInput;

  abstract run(input: TInput, context: ScraperContext): Promise<void>;
}
