import chromium from "@sparticuz/chromium";
import { chromium as playwright, type BrowserContext } from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";

export type UhcEligibilityBrowserSession = {
  browser: Awaited<ReturnType<typeof playwright.launch>>;
  context: BrowserContext;
};

const OPTUM_STYLE_CHROMIUM_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--use-gl=desktop",
  "--enable-webgl",
];
const MAC_CHROME_122_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function summarize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split(String.fromCharCode(10))[0].trim();
}

export async function launchUhcEligibilityBrowser(
  log: (message: string) => Promise<void>,
): Promise<UhcEligibilityBrowserSession> {
  const runtime = getAutomationRuntimeConfig();
  const contextOptions = {
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    ...(parseBoolean(process.env.PORTAL_UHC_ELIGIBILITY_CUSTOM_USER_AGENT, false)
      ? { userAgent: process.env.PORTAL_UHC_ELIGIBILITY_USER_AGENT?.trim() || MAC_CHROME_122_USER_AGENT }
      : {}),
  };

  if (runtime.environment === "vercel") {
    await log("Launching UHC eligibility with the Optum Pro production Chromium configuration.");
    const browser = await playwright.launch({
      args: Array.from(new Set([...chromium.args, ...OPTUM_STYLE_CHROMIUM_ARGS])),
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    return { browser, context: await browser.newContext(contextOptions) };
  }

  const headless = parseBoolean(process.env.PORTAL_UHC_ELIGIBILITY_HEADLESS, runtime.headless);
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "";
  await log(`Launching UHC eligibility with the Optum Pro Chromium configuration in ${headless ? "headless" : "headed"} mode.`);

  try {
    const browser = await playwright.launch({
      headless,
      args: OPTUM_STYLE_CHROMIUM_ARGS,
      ...(executablePath ? { executablePath } : { channel: "chromium" as const }),
    });
    return { browser, context: await browser.newContext(contextOptions) };
  } catch (error) {
    throw new Error(`UHC eligibility browser could not start: ${summarize(error)}`);
  }
}