import os from "node:os";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser, type BrowserContext } from "playwright-core";

export type IehpBrowserSession = {
  browser: Browser | null;
  context: BrowserContext;
};

export async function launchIehpBrowser(log: (message: string) => Promise<void>): Promise<IehpBrowserSession> {
  const isVercel = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV;
  const useChromeProfile = false;

  if (isVercel) {
    await log("Attempting @sparticuz/chromium browser launch for Vercel.");
    const browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    return { browser, context };
  }

  await log("Attempting local Chromium launch.");
  if (useChromeProfile) {
    const profilePath = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
    try {
      await log(`Attempting persistent Chrome profile launch: ${profilePath}`);
      const context = await playwright.launchPersistentContext(profilePath, {
        channel: "chrome",
        headless: false,
        viewport: null,
      });
      return { browser: context.browser(), context };
    } catch (error) {
      await log(`Persistent profile launch failed, falling back: ${(error as Error).message}`);
    }
  }

  const browser = await playwright.launch({ headless: true });
  const context = await browser.newContext();
  return { browser, context };
}
