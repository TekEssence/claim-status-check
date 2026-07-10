import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium, type BrowserContext } from "playwright-core";
import { envText } from "./env";
import { monitorBlueShieldFeedbackPopups } from "./overlays";
import { blueShieldWritableDataPath } from "./storage";
import type { BlueShieldCredentials } from "./types";

export async function launchBlueShieldPersistentContext(
  log: (message: string) => Promise<void>,
  credentials: BlueShieldCredentials,
): Promise<BrowserContext> {
  const profileRoot = envText("PORTAL_BLUE_SHIELD_USER_DATA_DIR") || blueShieldWritableDataPath("browser-profiles", "blue-shield");
  const profileId = createHash("sha256")
    .update(`${credentials.loginUrl.trim().toLowerCase()}::${credentials.username.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
  const userDataDir = path.join(profileRoot, profileId);
  await fs.mkdir(userDataDir, { recursive: true });

  const executablePath = envText("PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH") || undefined;
  await log(`Launching Blue Shield persistent browser profile: ${userDataDir}`);

  const launch = (profilePath: string) => chromium.launchPersistentContext(profilePath, {
    acceptDownloads: true,
    executablePath,
    headless: false,
    viewport: { width: 1600, height: 1000 },
  });

  let context: BrowserContext;
  try {
    context = await launch(userDataDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const recoveryDir = path.join(profileRoot, `${profileId}-recovery-${Date.now()}`);
    await fs.mkdir(recoveryDir, { recursive: true });
    await log(`Blue Shield profile startup failed. Retrying with a fresh recovery profile: ${message}`);
    context = await launch(recoveryDir);
  }
  monitorBlueShieldFeedbackPopups(context, log);
  return context;
}
