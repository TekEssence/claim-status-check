import type { JobEvent, LogEvent } from "../types";

export type PortalRuntimeConfig = {
  supportsLocal: boolean;
  supportsDeployed: boolean;
  requiresVpn: boolean;
};

export type PortalConfig = {
  id: string;
  name: string;
  runtime: PortalRuntimeConfig;
};

export type ScraperContext = {
  jobId: string;
  portalId: string;
  log: (event: LogEvent) => Promise<void>;
  emit: (event: JobEvent) => Promise<void>;
  isCancelled?: () => boolean;
  captureScreenshot?: (reason: string, rowIndex?: number) => Promise<void>;
};

export interface PortalScraper<TInput = unknown> {
  id: string;
  name: string;
  config: PortalConfig;
  validateInput(input: unknown): TInput;
  run(input: TInput, context: ScraperContext): Promise<void>;
}
