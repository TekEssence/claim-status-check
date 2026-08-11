import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

export async function launchPhysiciansBrowser(log: (message: string) => Promise<void>): Promise<Browser> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const profileRoot = process.env.PORTAL_PHYSICIANS_DOWNLOAD_DIR || path.join(process.cwd(), ".tmp", "physicians");
  await fs.mkdir(profileRoot, { recursive: true });
  await log("Launching Physicians browser.");
  return chromium.launch({
    executablePath,
    headless: false,
    args: ["--start-maximized"],
    timeout: 60000,
  });
}