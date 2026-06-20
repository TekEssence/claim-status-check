import os from "node:os";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser, type BrowserContext } from "playwright-core";
import { getRuntimeEnvironment } from "./environment";

export type BrowserLaunchResult = {
  browser: Browser | null;
  context: BrowserContext;
};

export async function launchAutomationBrowser(): Promise<BrowserLaunchResult> {
  if (getRuntimeEnvironment() === "vercel") {
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

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  const browser = await playwright.launch({
    headless: false,
    executablePath,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
  });

  return { browser, context };
}

export function getLocalChromeProfilePath(): string {
  return path.join(os.homedir(), "Library/Application Support/Google/Chrome");
}
