import fs from "node:fs/promises";
import { chromium, type BrowserContext } from "playwright-core";
import { envText } from "./env";
import { blueShieldWritableDataPath } from "./storage";

export async function launchBlueShieldPersistentContext(log: (message: string) => Promise<void>): Promise<BrowserContext> {
  const userDataDir = envText("PORTAL_BLUE_SHIELD_USER_DATA_DIR") || blueShieldWritableDataPath("browser-profiles", "blue-shield");
  await fs.mkdir(userDataDir, { recursive: true });

  const executablePath = envText("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH") || undefined;
  await log(`Launching Blue Shield persistent browser profile: ${userDataDir}`);

  return chromium.launchPersistentContext(userDataDir, {
    acceptDownloads: true,
    executablePath,
    headless: false,
    viewport: { width: 1600, height: 1000 },
  });
}
