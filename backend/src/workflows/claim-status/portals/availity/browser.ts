import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser, type BrowserContext, type LaunchOptions } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";

export type AvailityBrowserSession = {
  browser: Browser;
  context: BrowserContext;
};

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  return fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function summarizeLaunchError(error: unknown): string {
  const message = errorMessage(error).replace(/\x1b\[[0-9;]*m/g, "");
  const firstLine = message.split(/\r?\n/).find((line) => line.trim()) || message;
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}...` : firstLine;
}

async function launchLocalBrowserWithFallback(options: {
  headless: boolean;
  browserChannel: string;
  log: (message: string) => Promise<void>;
}): Promise<AvailityBrowserSession> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "";
  const attempts: Array<{ label: string; launchOptions: LaunchOptions }> = [];

  if (executablePath) {
    attempts.push({
      label: `explicit executable ${executablePath}`,
      launchOptions: { executablePath, headless: options.headless },
    });
  }

  if (options.browserChannel) {
    attempts.push({
      label: `configured browser channel ${options.browserChannel}`,
      launchOptions: { channel: options.browserChannel, headless: options.headless },
    });
  }

  attempts.push(
    {
      label: "Playwright bundled Chromium",
      launchOptions: { headless: options.headless },
    },
    {
      label: "installed Google Chrome",
      launchOptions: { channel: "chrome", headless: options.headless },
    },
    {
      label: "installed Microsoft Edge",
      launchOptions: { channel: "msedge", headless: options.headless },
    },
  );

  const seen = new Set<string>();
  let lastError: unknown = null;
  for (const attempt of attempts.filter((candidate) => {
    const key = JSON.stringify(candidate.launchOptions);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  })) {
    let browser: Browser | null = null;
    let context: BrowserContext | null = null;
    try {
      await options.log(`Launching Availity browser using ${attempt.label} (${options.headless ? "headless" : "headed"}).`);
      browser = await playwright.launch(attempt.launchOptions);
      context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1600, height: 1000 },
      });
      await context.newPage();
      return { browser, context };
    } catch (error) {
      lastError = error;
      await options.log(`Availity browser launch failed for ${attempt.label}: ${summarizeLaunchError(error)}`);
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }

  throw new Error(
    `Availity browser could not start after trying Playwright Chromium, Chrome, and Edge. Last error: ${summarizeLaunchError(lastError)}`,
  );
}

export async function launchAvailityBrowser(log: (message: string) => Promise<void>): Promise<AvailityBrowserSession> {
  const runtimeConfig = getAutomationRuntimeConfig();
  const browserChannel = String(process.env.PORTAL_AVAILITY_BROWSER_CHANNEL || "").trim();
  const headless = parseBoolean(process.env.PORTAL_AVAILITY_HEADLESS, runtimeConfig.headless);

  if (runtimeConfig.environment === "vercel") {
    await log("Launching Availity with @sparticuz/chromium.");
    const browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1600, height: 1000 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    return { browser, context };
  }

  return launchLocalBrowserWithFallback({
    headless,
    browserChannel,
    log,
  });
}
