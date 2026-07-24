import os from "node:os";
import path from "node:path";
import { isServerlessEnvironment } from "@/backend/src/core/environment";

export function blueShieldWritableDataPath(...parts: string[]): string {
  const root = isServerlessEnvironment() ? os.tmpdir() : process.cwd();
  return path.join(root, "data", ...parts);
}
