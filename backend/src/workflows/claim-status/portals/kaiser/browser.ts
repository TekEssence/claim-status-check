import fs from "node:fs/promises";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";
import { getWorkflowRuntimePath } from "@/backend/src/core/storage";
import { chromium, type Browser } from "playwright-core";

async function launchOnce(executablePath: string | undefined, headless: boolean): Promise<Browser> {
  return chromium.launch({
    executablePath,
    headless,
    args: headless ? [] : ["--start-maximized"],
    timeout: 60000,
  });
}

export async function launchKaiserBrowser(log: (message: string) => Promise<void>): Promise<Browser> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const runtimeConfig = getAutomationRuntimeConfig();
  const profileRoot = process.env.PORTAL_KAISER_DOWNLOAD_DIR || getWorkflowRuntimePath("browser", "kaiser");
  await fs.mkdir(profileRoot, { recursive: true });
  await log(`Launching Kaiser browser (${runtimeConfig.headless ? "headless" : "headed"}).`);

  // chromium.launch() can resolve with a Browser handle even when the underlying chrome.exe
  // process gets killed immediately after starting (commonly by antivirus/EDR, a corporate
  // policy blocking the executable, or a corrupted/locked Playwright install). In that case the
  // very next call (browser.newPage()) fails with a cryptic "Target page, context or browser has
  // been closed" error that looks like an automation bug but isn't. Verify the browser is
  // actually still connected right after launch, and retry once before failing with a clear,
  // actionable message.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const browser = await launchOnce(executablePath, runtimeConfig.headless);
    if (browser.isConnected()) {
      browser.on("disconnected", () => {
        log("Kaiser browser disconnected (Chrome process closed or was closed externally).").catch(() => {});
      });
      return browser;
    }

    await log(
      `Kaiser browser process closed immediately after launching (attempt ${attempt}/2). ` +
        "This is not an automation-logic issue - it typically means antivirus/EDR or a corporate " +
        "policy is terminating chrome.exe right after it starts, the Playwright Chromium install " +
        "is corrupted, or a stale locked profile folder is blocking startup.",
    );
    if (attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  throw new Error(
    "Kaiser browser closed immediately after launching on both attempts. Ask IT to check whether " +
      "antivirus/EDR is blocking chrome.exe launches from the Playwright install path, run " +
      "`npx playwright install chromium --force` to reinstall the browser binary, and delete any " +
      "stale folders under %TEMP%\\playwright_chromiumdev_profile-* left over from a previous crashed run.",
  );
}
