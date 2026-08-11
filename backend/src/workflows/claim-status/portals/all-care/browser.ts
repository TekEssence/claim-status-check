import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser, type BrowserContext, type LaunchOptions } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";

export type AllCareBrowserSession = { browser: Browser; context: BrowserContext };

const ALL_CARE_SLOW_MO_MS = 250;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)[0];
}

export async function launchAllCareBrowser(log: (message: string) => Promise<void>): Promise<AllCareBrowserSession> {
  const runtime = getAutomationRuntimeConfig();
  if (runtime.environment === "vercel") {
    const browser = await playwright.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, slowMo: ALL_CARE_SLOW_MO_MS });
    return { browser, context: await browser.newContext({ viewport: { width: 1440, height: 900 } }) };
  }

  const explicitPath = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  const channel = String(process.env.PORTAL_ALL_CARE_BROWSER_CHANNEL || "").trim();
  const attempts: Array<[string, LaunchOptions]> = [];
  if (explicitPath) attempts.push(["configured executable", { executablePath: explicitPath, headless: runtime.headless, slowMo: ALL_CARE_SLOW_MO_MS }]);
  if (channel) attempts.push([`configured ${channel}`, { channel, headless: runtime.headless, slowMo: ALL_CARE_SLOW_MO_MS }]);
  attempts.push(
    ["Playwright Chromium", { headless: runtime.headless, slowMo: ALL_CARE_SLOW_MO_MS }],
    ["Google Chrome", { channel: "chrome", headless: runtime.headless, slowMo: ALL_CARE_SLOW_MO_MS }],
    ["Microsoft Edge", { channel: "msedge", headless: runtime.headless, slowMo: ALL_CARE_SLOW_MO_MS }],
  );

  let lastError: unknown;
  for (const [label, options] of attempts) {
    try {
      await log(`Launching AllCare with ${label}.`);
      const browser = await playwright.launch(options);
      return { browser, context: await browser.newContext({ viewport: { width: 1440, height: 900 } }) };
    } catch (error) {
      lastError = error;
      await log(`AllCare browser launch failed with ${label}: ${message(error)}`);
    }
  }
  throw new Error(`AllCare browser could not start. ${message(lastError)}`);
}
