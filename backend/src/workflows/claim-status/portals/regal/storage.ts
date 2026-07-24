import os from "node:os";
import path from "node:path";
import { isServerlessEnvironment } from "@/backend/src/core/environment";

export function regalWritableDataPath(...parts: string[]): string {
  const isServerless = isServerlessEnvironment();
  const root = isServerless ? os.tmpdir() : process.cwd();
  return path.join(root, "data", ...parts);
}
