import os from "node:os";
import path from "node:path";

export function blueShieldWritableDataPath(...parts: string[]): string {
  const root = process.env.VERCEL === "1" || process.env.VERCEL_ENV ? os.tmpdir() : process.cwd();
  return path.join(root, "data", ...parts);
}
