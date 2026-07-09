import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser, type BrowserContext } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";
import { loadAerialEnvironment } from "./env";

export type AerialBrowserSession = {
  browser: Browser;
  context: BrowserContext;
};

export async function launchAerialBrowser(log: (message: string) => Promise<void>): Promise<AerialBrowserSession> {
  loadAerialEnvironment();
  const runtimeConfig = getAutomationRuntimeConfig();
  const browserChannel = String(process.env.PORTAL_AERIAL_BROWSER_CHANNEL || "").trim();

  if (runtimeConfig.environment === "vercel") {
    await log("Attempting @sparticuz/chromium browser launch for Aerial.");
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

  await log(`Attempting local Chromium launch for Aerial in ${runtimeConfig.headless ? "headless" : "headed"} mode.`);
  const browser = await playwright.launch({
    headless: runtimeConfig.headless,
    ...(browserChannel ? { channel: browserChannel } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  return { browser, context };
}
