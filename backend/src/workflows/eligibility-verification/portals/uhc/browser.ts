import chromium from "@sparticuz/chromium";
import { chromium as playwright, type BrowserContext, type LaunchOptions } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";

export type UhcEligibilityBrowserSession = {
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
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0];
}

export async function launchUhcEligibilityBrowser(
  log: (message: string) => Promise<void>,
): Promise<UhcEligibilityBrowserSession> {
  const runtime = getAutomationRuntimeConfig();
  if (runtime.environment === "vercel") {
    const browser = await playwright.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true });
    return { browser, context: await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } }) };
  }

  const headless = parseBoolean(process.env.PORTAL_UHC_ELIGIBILITY_HEADLESS, runtime.headless);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "";
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];
  if (executablePath) attempts.push({ label: "configured executable", options: { executablePath, headless } });
  attempts.push(
    { label: "Playwright Chromium", options: { headless } },
    { label: "Google Chrome", options: { channel: "chrome", headless } },
    { label: "Microsoft Edge", options: { channel: "msedge", headless } },
  );

  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      await log(`Launching UHC eligibility browser using ${attempt.label}.`);
      const browser = await playwright.launch(attempt.options);
      return { browser, context: await browser.newContext({ acceptDownloads: true, viewport: { width: 1600, height: 1000 } }) };
    } catch (error) {
      lastError = error;
      await log(`UHC eligibility browser launch failed for ${attempt.label}: ${summarize(error)}`);
    }
  }
  throw new Error(`UHC eligibility browser could not start: ${summarize(lastError)}`);
}
