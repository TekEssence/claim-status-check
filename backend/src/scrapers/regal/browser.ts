import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser, type BrowserContext } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";
import { loadRegalEnvironment } from "./env";

export type RegalBrowserSession = {
  browser: Browser;
  context: BrowserContext;
};

export async function launchRegalBrowser(log: (message: string) => Promise<void>): Promise<RegalBrowserSession> {
  loadRegalEnvironment();
  const runtimeConfig = getAutomationRuntimeConfig();

  if (runtimeConfig.environment === "vercel") {
    await log("Attempting @sparticuz/chromium browser launch for Regal.");
    const browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    return { browser, context };
  }

  await log(`Attempting local Chromium launch for Regal in ${runtimeConfig.headless ? "headless" : "headed"} mode.`);
  const browser = await playwright.launch({ headless: runtimeConfig.headless });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  return { browser, context };
}
