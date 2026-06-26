import fs from "node:fs";
import path from "node:path";

let loaded = false;

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    const value = line.slice(equalsIndex + 1).trim();
    if (!key) continue;
    values[key] = value;
  }

  return values;
}

export function loadBackendEnv(): void {
  if (loaded) return;
  loaded = true;

  const envPathSetting = process.env.ENV_PATH;
  if (!envPathSetting) {
    return;
  }

  const envFilePath = path.resolve(envPathSetting);
  if (!fs.existsSync(envFilePath)) {
    return;
  }

  const parsed = parseEnvFile(fs.readFileSync(envFilePath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
