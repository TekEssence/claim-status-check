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
const STANDARD_CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

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
    userAgent: process.env.PORTAL_UHC_ELIGIBILITY_USER_AGENT?.trim() || STANDARD_CHROME_USER_AGENT,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  };

  const prepareContext = async (context: BrowserContext): Promise<BrowserContext> => {
    await context.addInitScript(() => {
      Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
      Object.defineProperty(Navigator.prototype, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(Navigator.prototype, "platform", { get: () => "Win32" });
    });
    return context;
  };

  if (runtime.environment === "vercel") {
    await log("Launching UHC eligibility with the Optum Pro production Chromium configuration.");
    const browser = await playwright.launch({
      args: Array.from(new Set([...chromium.args, ...OPTUM_STYLE_CHROMIUM_ARGS])),
      executablePath: await chromium.executablePath(),
      headless: true,
    });
    return { browser, context: await prepareContext(await browser.newContext(contextOptions)) };
  }

  const headless = true;
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "";
  await log(`Launching UHC eligibility with the Optum Pro Chromium configuration in ${headless ? "headless" : "headed"} mode.`);

  try {
    const browser = await playwright.launch({
      headless,
      args: OPTUM_STYLE_CHROMIUM_ARGS,
      ...(executablePath ? { executablePath } : { channel: "chromium" as const }),
    });
    return { browser, context: await prepareContext(await browser.newContext(contextOptions)) };
  } catch (error) {
    throw new Error(`UHC eligibility browser could not start: ${summarize(error)}`);
  }
}
