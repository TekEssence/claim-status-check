import fs from "node:fs/promises";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";
import { getWorkflowRuntimePath } from "@/backend/src/core/storage";
import { chromium, type Browser, type BrowserContext } from "playwright-core";

export type CignaBrowserSession = { browser: Browser; context: BrowserContext };

function desktopChromeUserAgent(browserVersion: string): string {
  const major = browserVersion.match(/\d+/)?.[0] || "149";
  const platform = process.platform === "win32" ? "Windows NT 10.0; Win64; x64" : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export async function launchCignaBrowser(log: (message: string) => Promise<void>): Promise<CignaBrowserSession> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const runtimeConfig = getAutomationRuntimeConfig();
  const profileRoot = process.env.PORTAL_CIGNA_DOWNLOAD_DIR || getWorkflowRuntimePath("browser", "cigna");
  await fs.mkdir(profileRoot, { recursive: true });
  await log(`Launching Cigna browser (${runtimeConfig.headless ? "headless" : "headed"}).`);
  const browser = await chromium.launch({
    executablePath,
    headless: runtimeConfig.headless,
    args: ["--disable-blink-features=AutomationControlled", "--window-size=1600,1000", ...(!runtimeConfig.headless ? ["--start-maximized"] : [])],
    timeout: 60000,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    viewport: { width: 1600, height: 1000 },
    screen: { width: 1600, height: 1000 },
    userAgent: desktopChromeUserAgent(browser.version()),
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
    colorScheme: "light",
  });
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, "webdriver", { get: () => undefined });
  });
  await log(`Cigna desktop browser context ready (Chrome ${browser.version()}).`);
  return { browser, context };
}
