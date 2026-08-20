import chromium from "@sparticuz/chromium";
import { chromium as playwright, type Browser, type BrowserContext, type LaunchOptions } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";

export type AstronaBrowserSession = { browser: Browser; context: BrowserContext };

const ASTRONA_SLOW_MO_MS = 250;

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/)[0];
}

export async function launchAstronaBrowser(log: (message: string) => Promise<void>): Promise<AstronaBrowserSession> {
  const runtime = getAutomationRuntimeConfig();
  if (runtime.environment === "vercel") {
    const browser = await playwright.launch({ args: chromium.args, executablePath: await chromium.executablePath(), headless: true, slowMo: ASTRONA_SLOW_MO_MS });
    return { browser, context: await browser.newContext({ viewport: { width: 1440, height: 900 } }) };
  }

  const explicitPath = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  const channel = String(process.env.PORTAL_ASTRONA_BROWSER_CHANNEL || "").trim();
  const attempts: Array<[string, LaunchOptions]> = [];
  if (explicitPath) attempts.push(["configured executable", { executablePath: explicitPath, headless: true, slowMo: ASTRONA_SLOW_MO_MS }]);
  if (channel) attempts.push([`configured ${channel}`, { channel, headless: true, slowMo: ASTRONA_SLOW_MO_MS }]);
  attempts.push(
    ["Playwright Chromium", { headless: true, slowMo: ASTRONA_SLOW_MO_MS }],
    ["Google Chrome", { channel: "chrome", headless: true, slowMo: ASTRONA_SLOW_MO_MS }],
    ["Microsoft Edge", { channel: "msedge", headless: true, slowMo: ASTRONA_SLOW_MO_MS }],
  );

  let lastError: unknown;
  for (const [label, options] of attempts) {
    try {
      await log(`Launching Astrona with ${label}.`);
      const browser = await playwright.launch(options);
      return { browser, context: await browser.newContext({ viewport: { width: 1440, height: 900 } }) };
    } catch (error) {
      lastError = error;
      await log(`Astrona browser launch failed with ${label}: ${message(error)}`);
    }
  }
  throw new Error(`Astrona browser could not start. ${message(lastError)}`);
}
