import { spawnSync } from "node:child_process";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

rmSync(".next", { recursive: true, force: true });

const apiDir = join("app", "api");
const apiBackupDir = join(".next-static-api-backup");

function restoreApiRoutes() {
  if (existsSync(apiBackupDir) && !existsSync(apiDir)) {
    renameSync(apiBackupDir, apiDir);
  }
}

restoreApiRoutes();
if (existsSync(apiDir)) {
  renameSync(apiDir, apiBackupDir);
}

const command = process.platform === "win32"
  ? join("node_modules", ".bin", "next.cmd")
  : join("node_modules", ".bin", "next");
try {
  const result = spawnSync(command, ["build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      STATIC_EXPORT: "true",
    },
    shell: process.platform === "win32",
  });

  if (result.error) {
    console.error(result.error);
  }

  process.exitCode = result.status ?? 1;
} finally {
  restoreApiRoutes();
}
