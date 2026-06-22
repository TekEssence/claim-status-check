import type { Browser, BrowserContext, Page } from "playwright-core";
import { getRuntimeEnvironment } from "./environment";

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

export type AutomationRuntimeConfig = {
  environment: "local" | "vercel";
  headless: boolean;
  keepBrowserOpen: boolean;
};

export function getAutomationRuntimeConfig(): AutomationRuntimeConfig {
  const environment = getRuntimeEnvironment();
  const isVercel = environment === "vercel";
  const headless = isVercel
    ? true
    : parseBoolean(process.env.BROWSER_HEADLESS ?? process.env.HEADLESS, false);

  return {
    environment,
    headless,
    keepBrowserOpen: isVercel ? false : parseBoolean(process.env.BROWSER_KEEP_OPEN, false),
  };
}

export async function closeAutomationResources({
  browser,
  context,
  page,
  log,
}: {
  browser?: Browser | null;
  context?: BrowserContext | null;
  page?: Page | null;
  log?: (message: string) => Promise<void>;
}): Promise<void> {
  const config = getAutomationRuntimeConfig();
  if (config.keepBrowserOpen) {
    await log?.("BROWSER_KEEP_OPEN=true, leaving browser open for local debugging.");
    return;
  }

  await page?.close().catch(() => {});
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
