import fs from "node:fs/promises";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";
import { getWorkflowRuntimePath } from "@/backend/src/core/storage";
import { chromium, type Browser } from "playwright-core";

export async function launchPhysiciansBrowser(log: (message: string) => Promise<void>): Promise<Browser> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const runtimeConfig = getAutomationRuntimeConfig();
  const profileRoot = process.env.PORTAL_PHYSICIANS_DOWNLOAD_DIR || getWorkflowRuntimePath("browser", "physicians");
  await fs.mkdir(profileRoot, { recursive: true });
  await log(`Launching Physicians browser (${runtimeConfig.headless ? "headless" : "headed"}).`);
  return chromium.launch({
    executablePath,
    headless: runtimeConfig.headless,
    args: runtimeConfig.headless ? [] : ["--start-maximized"],
    timeout: 60000,
  });
}
