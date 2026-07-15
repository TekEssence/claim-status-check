import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser } from "playwright-core";

export async function launchKaiserBrowser(log: (message: string) => Promise<void>): Promise<Browser> {
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;
  const profileRoot = process.env.PORTAL_KAISER_DOWNLOAD_DIR || path.join(process.cwd(), ".tmp", "kaiser");
  await fs.mkdir(profileRoot, { recursive: true });
  await log("Launching Kaiser browser.");

  return chromium.launch({
    executablePath,
    headless: false,
    args: ["--start-maximized"],
  });
}
