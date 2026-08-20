import os from "node:os";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import {
  chromium as playwright,
  type Browser,
  type BrowserContext,
  type LaunchOptions,
} from "playwright-core";
import { getAutomationRuntimeConfig } from "./runtime-config";

export type BrowserLaunchResult = {
  browser: Browser | null;
  context: BrowserContext;
};

const DESKTOP_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const DESKTOP_VIEWPORT = { width: 1920, height: 1080 };
const AUTOMATION_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--window-size=1920,1080",
];

function summarizeLaunchError(error: unknown): string {
  const message = (error instanceof Error ? error.message : String(error)).replace(
    /\x1b\[[0-9;]*m/g,
    "",
  );
  const firstLine = message.split(/\r?\n/).find((line) => line.trim()) || message;
  return firstLine.length > 500 ? `${firstLine.slice(0, 500)}...` : firstLine;
}

async function launchLocalBrowser(headless: boolean): Promise<Browser> {
  const executablePath = String(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "").trim();
  const browserChannel = String(process.env.AUTOMATION_BROWSER_CHANNEL || "").trim();
  const attempts: Array<{ label: string; options: LaunchOptions }> = [];

  if (executablePath) {
    attempts.push({
      label: `explicit executable ${executablePath}`,
      options: { executablePath, headless, args: AUTOMATION_LAUNCH_ARGS },
    });
  }
  if (browserChannel) {
    attempts.push({
      label: `configured browser channel ${browserChannel}`,
      options: { channel: browserChannel, headless, args: AUTOMATION_LAUNCH_ARGS },
    });
  }
  attempts.push(
    { label: "Playwright bundled Chromium", options: { headless, args: AUTOMATION_LAUNCH_ARGS } },
    { label: "installed Google Chrome", options: { channel: "chrome", headless, args: AUTOMATION_LAUNCH_ARGS } },
    { label: "installed Microsoft Edge", options: { channel: "msedge", headless, args: AUTOMATION_LAUNCH_ARGS } },
  );

  const seen = new Set<string>();
  let lastError: unknown = null;
  const failures: string[] = [];

  for (const attempt of attempts) {
    const key = JSON.stringify(attempt.options);
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      return await playwright.launch(attempt.options);
    } catch (error) {
      lastError = error;
      failures.push(`${attempt.label}: ${summarizeLaunchError(error)}`);
    }
  }

  throw new Error(
    `Automation browser could not start after trying the configured browser, Playwright Chromium, Chrome, and Edge. ${failures.join(" | ") || summarizeLaunchError(lastError)}`,
  );
}

export async function launchAutomationBrowser(options: { headless?: boolean } = {}): Promise<BrowserLaunchResult> {
  const runtimeConfig = getAutomationRuntimeConfig();
  const headless = options.headless ?? runtimeConfig.headless;
  if (runtimeConfig.environment === "vercel") {
    const browser = await playwright.launch({
      args: [...chromium.args, ...AUTOMATION_LAUNCH_ARGS],
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    const context = await browser.newContext({
      viewport: DESKTOP_VIEWPORT,
      screen: DESKTOP_VIEWPORT,
      userAgent: DESKTOP_CHROME_USER_AGENT,
      locale: "en-US",
      timezoneId: "America/Los_Angeles",
      colorScheme: "light",
    });
    await reduceAutomationSignals(context);
    return { browser, context };
  }

  const browser = await launchLocalBrowser(headless);
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: DESKTOP_VIEWPORT,
    screen: DESKTOP_VIEWPORT,
    userAgent: DESKTOP_CHROME_USER_AGENT,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    colorScheme: "light",
  });
  await reduceAutomationSignals(context);

  return { browser, context };
}

async function reduceAutomationSignals(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });
  });
}

export function getLocalChromeProfilePath(): string {
  return path.join(os.homedir(), "Library/Application Support/Google/Chrome");
}
