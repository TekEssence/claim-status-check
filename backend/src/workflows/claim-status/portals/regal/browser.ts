import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser, type BrowserContext, type LaunchOptions } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";
import { loadRegalEnvironment } from "./env";

export type RegalBrowserSession = {
  browser: Browser;
  context: BrowserContext;
};

function summarizeLaunchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(/\r?\n/)[0] || "Unknown browser launch error.";
}

async function launchWithContext(options: LaunchOptions): Promise<RegalBrowserSession> {
  const browser = await playwright.launch(options);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  });
  return { browser, context };
}

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

  const configuredChannel = String(process.env.PORTAL_REGAL_BROWSER_CHANNEL || "").trim();
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];
  if (configuredChannel) {
    attempts.push({
      label: `configured browser channel ${configuredChannel}`,
      options: { channel: configuredChannel, headless: runtimeConfig.headless },
    });
  }
  attempts.push(
    { label: "Playwright bundled Chromium", options: { headless: runtimeConfig.headless } },
    { label: "installed Google Chrome", options: { channel: "chrome", headless: runtimeConfig.headless } },
    { label: "installed Microsoft Edge", options: { channel: "msedge", headless: runtimeConfig.headless } },
  );

  let lastError: unknown = null;
  for (const attempt of attempts) {
    try {
      await log(`Attempting ${attempt.label} launch for Regal in ${runtimeConfig.headless ? "headless" : "headed"} mode.`);
      const session = await launchWithContext(attempt.options);
      await log(`Regal browser launched using ${attempt.label}.`);
      return session;
    } catch (error) {
      lastError = error;
      await log(`Regal ${attempt.label} launch failed: ${summarizeLaunchError(error)}`);
    }
  }

  throw new Error(
    `Regal browser could not start after trying Playwright Chromium, Chrome, and Edge. Last error: ${summarizeLaunchError(lastError)}`,
  );
}
