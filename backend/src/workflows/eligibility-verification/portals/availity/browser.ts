import chromium from "@sparticuz/chromium";
import { chromium as playwright, type BrowserContext, type LaunchOptions } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";

export type AvailityEligibilityBrowserSession = {
  browser: Awaited<ReturnType<typeof playwright.launch>>;
  context: BrowserContext;
};

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function summarize(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, "");
  return message.split(/\r?\n/).find((line) => line.trim()) || message;
}

export async function launchAvailityEligibilityBrowser(
  log: (message: string) => Promise<void>,
): Promise<AvailityEligibilityBrowserSession> {
  const runtimeConfig = getAutomationRuntimeConfig();
  if (runtimeConfig.environment === "vercel") {
    await log("Launching Availity eligibility browser with @sparticuz/chromium.");
    const browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 1600, height: 1000 },
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36",
    });
    return { browser, context };
  }

  const headless = parseBoolean(
    process.env.PORTAL_AVAILITY_ELIGIBILITY_HEADLESS,
    parseBoolean(process.env.PORTAL_AVAILITY_HEADLESS, runtimeConfig.headless),
  );
  const configuredChannel = String(
    process.env.PORTAL_AVAILITY_ELIGIBILITY_BROWSER_CHANNEL ??
    process.env.PORTAL_AVAILITY_BROWSER_CHANNEL ??
    "",
  ).trim();
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "";
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];
  if (executablePath) attempts.push({ label: "configured executable", options: { executablePath, headless } });
  if (configuredChannel) attempts.push({ label: configuredChannel, options: { channel: configuredChannel, headless } });
  attempts.push(
    { label: "Playwright Chromium", options: { headless } },
    { label: "Google Chrome", options: { channel: "chrome", headless } },
    { label: "Microsoft Edge", options: { channel: "msedge", headless } },
  );

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      await log(`Launching Availity eligibility browser using ${attempt.label}.`);
      const browser = await playwright.launch(attempt.options);
      const context = await browser.newContext({
        acceptDownloads: true,
        viewport: { width: 1600, height: 1000 },
      });
      return { browser, context };
    } catch (error) {
      lastError = error;
      await log(`Availity eligibility browser launch failed for ${attempt.label}: ${summarize(error)}`);
    }
  }
  throw new Error(`Availity eligibility browser could not start: ${summarize(lastError)}`);
}
