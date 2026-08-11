import chromium from "@sparticuz/chromium";
import {
  chromium as playwrightChromium,
  firefox as playwrightFirefox,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type BrowserType,
} from "playwright-core";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);
const MAC_CHROME_122_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

type OptumProBrowserChoice = "chromium" | "firefox" | "cdp";

export type OptumProBrowserSession = {
  browser: Browser | null;
  context: BrowserContext;
  launchInfo: OptumProBrowserLaunchInfo;
};

export type OptumProBrowserLaunchInfo = {
  browserChannel: string;
  browserChoice: OptumProBrowserChoice;
  cdpEndpointConfigured: boolean;
  customUserAgentEnabled: boolean;
  executablePath?: string;
  headless: boolean;
  launchArgs: string[];
  launchedByPlaywright: boolean;
  persistentProfilePath?: string;
  usesPersistentProfile: boolean;
  usesSparticuzChromium: boolean;
};

export async function launchOptumProBrowser(
  log: (message: string) => Promise<void>
): Promise<OptumProBrowserSession> {
  const runtimeConfig = getAutomationRuntimeConfig();
  const browserChoice = optumProBrowserChoice();
  const headless = runtimeConfig.environment === "vercel" ? true : optumProHeadless(runtimeConfig.headless);
  const cdpEndpoint = optumProCdpEndpoint();
  const contextOptions = optumProContextOptions();

  if (browserChoice === "cdp") {
    if (!cdpEndpoint) {
      throw new Error("Optum Pro BROWSER=cdp requires BROWSER_CDP_ENDPOINT or CDP_ENDPOINT.");
    }

    await log(`Connecting to existing Chrome over CDP for Optum Pro: ${redactEndpoint(cdpEndpoint)}.`);
    const browser = await playwrightChromium.connectOverCDP(cdpEndpoint);
    const context = await browser.newContext(contextOptions);
    await log("Fresh non-persistent Optum Pro browser context created over CDP.");
    return buildSession(browser, context, {
      browserChannel: "cdp",
      browserChoice,
      cdpEndpointConfigured: true,
      customUserAgentEnabled: Boolean(contextOptions.userAgent),
      headless,
      launchArgs: [],
      launchedByPlaywright: false,
      usesPersistentProfile: false,
      usesSparticuzChromium: false,
    });
  }

  const isFirefox = browserChoice === "firefox";
  const browserType = isFirefox ? playwrightFirefox : playwrightChromium;
  const executablePath = optumProExecutablePath(browserChoice);
  const launchArgs = await optumProLaunchArgs(browserChoice, runtimeConfig.environment);
  const usesSparticuzChromium = runtimeConfig.environment === "vercel" && !isFirefox && !executablePath;

  await log(`Attempting Optum Pro ${browserChoice} launch in ${headless ? "headless" : "headed"} mode.`);
  if (executablePath) await log(`Using configured Optum Pro executable path: ${executablePath}.`);
  if (usesSparticuzChromium) await log("Using @sparticuz/chromium launch settings for Optum Pro production runtime.");

  const browser = await browserType.launch({
    headless,
    ...(executablePath ? { executablePath } : {}),
    ...(!isFirefox && !executablePath && runtimeConfig.environment === "vercel" ? { executablePath: await chromium.executablePath() } : {}),
    ...(launchArgs.length ? { args: launchArgs } : {}),
    ...(!isFirefox && !executablePath && runtimeConfig.environment !== "vercel" ? { channel: "chromium" as const } : {}),
  });

  await log(`Optum Pro ${browserChoice} launched successfully.`);
  await log(`Browser version: ${browser.version()}.`);

  const context = await browser.newContext(contextOptions);
  await log("Fresh non-persistent Optum Pro browser context created.");

  return buildSession(browser, context, {
    browserChannel: isFirefox ? "firefox" : usesSparticuzChromium ? "sparticuz-chromium" : executablePath ? "executable-path" : "chromium",
    browserChoice,
    cdpEndpointConfigured: Boolean(cdpEndpoint),
    customUserAgentEnabled: Boolean(contextOptions.userAgent),
    executablePath,
    headless,
    launchArgs,
    launchedByPlaywright: true,
    usesPersistentProfile: false,
    usesSparticuzChromium,
  });
}

function buildSession(browser: Browser, context: BrowserContext, launchInfo: OptumProBrowserLaunchInfo): OptumProBrowserSession {
  return {
    browser,
    context,
    launchInfo,
  };
}

function envText(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return "";
}

function envBoolean(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) continue;
    if (TRUE_VALUES.has(value)) return true;
    if (FALSE_VALUES.has(value)) return false;
  }
  return fallback;
}

function optumProBrowserChoice(): OptumProBrowserChoice {
  const configured = envText("OPTUM_PRO_BROWSER", "BROWSER").toLowerCase();
  const cdpEnabled = envBoolean(["OPTUM_PRO_ENABLE_CDP", "ENABLE_CDP"], false);
  if (configured === "cdp" || cdpEnabled) return "cdp";
  if (configured === "firefox") return "firefox";
  return "chromium";
}

function optumProHeadless(fallback: boolean): boolean {
  return envBoolean(["OPTUM_PRO_HEADLESS", "HEADLESS", "BROWSER_HEADLESS"], fallback);
}

function optumProCdpEndpoint(): string {
  return envText("OPTUM_PRO_CDP_ENDPOINT", "BROWSER_CDP_ENDPOINT", "CDP_ENDPOINT");
}

function optumProExecutablePath(browserChoice: OptumProBrowserChoice): string | undefined {
  if (browserChoice === "firefox") {
    return envText("OPTUM_PRO_FIREFOX_EXECUTABLE_PATH", "FIREFOX_EXECUTABLE_PATH") || undefined;
  }
  return envText("OPTUM_PRO_CHROMIUM_EXECUTABLE_PATH", "PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH", "BROWSER_EXECUTABLE_PATH") || undefined;
}

async function optumProLaunchArgs(browserChoice: OptumProBrowserChoice, environment: "local" | "vercel"): Promise<string[]> {
  if (browserChoice === "firefox") return [];

  const args = [
    "--disable-blink-features=AutomationControlled",
  ];

  if (environment === "vercel") {
    return Array.from(new Set([...chromium.args, ...args]));
  }

  return args;
}

function optumProContextOptions(): BrowserContextOptions {
  const customUserAgentEnabled = envBoolean(["OPTUM_PRO_CUSTOM_USER_AGENT", "CUSTOM_USER_AGENT"], false);
  const userAgent = customUserAgentEnabled
    ? envText("OPTUM_PRO_USER_AGENT", "BROWSER_USER_AGENT") || MAC_CHROME_122_USER_AGENT
    : "";

  return {
    acceptDownloads: true,
    viewport: { width: 1280, height: 800 },
    ...(userAgent ? { userAgent } : {}),
  };
}

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.username || url.password) {
      url.username = url.username ? "<redacted>" : "";
      url.password = url.password ? "<redacted>" : "";
    }
    return url.toString();
  } catch {
    return endpoint;
  }
}
