import fs from "node:fs";
import path from "node:path";

function parseEnvFile(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadEnvFile(filePath: string, override: boolean): void {
  if (!filePath || !fs.existsSync(filePath)) return;
  const values = parseEnvFile(fs.readFileSync(filePath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (override || process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

function externalEnvPath(): string {
  return (
    process.env.PORTAL_BLUE_SHIELD_ENV_PATH ||
    process.env.BLUE_SHIELD_ENV_PATH ||
    process.env.env_path ||
    process.env.ENV_PATH ||
    ""
  ).trim();
}

export function loadBlueShieldEnvironment(): void {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, ".env"), false);
  loadEnvFile(path.join(cwd, ".env.local"), true);

  const envPath = externalEnvPath();
  if (envPath) {
    loadEnvFile(envPath, true);
  }
}

export function envText(name: string): string {
  return String(process.env[name] ?? "").trim();
}

export function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
