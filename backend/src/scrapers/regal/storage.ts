import os from "node:os";
import path from "node:path";

export function regalWritableDataPath(...parts: string[]): string {
  const isVercel = process.env.VERCEL === "1" || Boolean(process.env.VERCEL_ENV);
  const root = isVercel ? os.tmpdir() : process.cwd();
  return path.join(root, "data", ...parts);
}
