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
      options: { executablePath, headless },
    });
  }
  if (browserChannel) {
    attempts.push({
      label: `configured browser channel ${browserChannel}`,
      options: { channel: browserChannel, headless },
    });
  }
  attempts.push(
    { label: "Playwright bundled Chromium", options: { headless } },
    { label: "installed Google Chrome", options: { channel: "chrome", headless } },
    { label: "installed Microsoft Edge", options: { channel: "msedge", headless } },
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

export async function launchAutomationBrowser(): Promise<BrowserLaunchResult> {
  const runtimeConfig = getAutomationRuntimeConfig();
  if (runtimeConfig.environment === "vercel") {
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

  const browser = await launchLocalBrowser(runtimeConfig.headless);
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
  });

  return { browser, context };
}

export function getLocalChromeProfilePath(): string {
  return path.join(os.homedir(), "Library/Application Support/Google/Chrome");
}
