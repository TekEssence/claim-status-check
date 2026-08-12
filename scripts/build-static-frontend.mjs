import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const tempRoot = ".next-static-build";
const outputDir = "out";

const rootFiles = [
  ".env.local",
  "next-env.d.ts",
  "next.config.ts",
  "package.json",
  "postcss.config.mjs",
  "tsconfig.json",
];

const rootDirs = [
  "app",
  "frontend",
  "public",
];

const extraSourcePaths = [
  "backend/src/workflows/claim-status/portals/iehp/claims",
];

function shouldSkip(sourcePath) {
  const normalized = sourcePath.replaceAll("\\", "/");
  return (
    normalized === "app/api" ||
    normalized.startsWith("app/api/") ||
    normalized.includes("/node_modules/") ||
    normalized.includes("/.next/") ||
    normalized.includes("/out/") ||
    normalized.includes("/.sst/") ||
    normalized.includes("/.tmp/")
  );
}

function copyProjectPath(source, destination) {
  if (!existsSync(source) || shouldSkip(source)) return;

  const stats = statSync(source);
  if (stats.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const entry of readdirSync(source)) {
      copyProjectPath(join(source, entry), join(destination, entry));
    }
    return;
  }

  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination);
}

rmSync(".next", { recursive: true, force: true });
rmSync(outputDir, { recursive: true, force: true });
rmSync(tempRoot, { recursive: true, force: true });
mkdirSync(tempRoot, { recursive: true });

for (const file of rootFiles) {
  copyProjectPath(file, join(tempRoot, file));
}

for (const dir of rootDirs) {
  copyProjectPath(dir, join(tempRoot, dir));
}

for (const sourcePath of extraSourcePaths) {
  copyProjectPath(sourcePath, join(tempRoot, sourcePath));
}

const command = process.platform === "win32"
  ? join(process.cwd(), "node_modules", ".bin", "next.cmd")
  : join(process.cwd(), "node_modules", ".bin", "next");

const result = spawnSync(command, ["build"], {
  cwd: tempRoot,
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

if ((result.status ?? 1) !== 0) {
  rmSync(tempRoot, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

cpSync(join(tempRoot, outputDir), outputDir, { recursive: true });
rmSync(tempRoot, { recursive: true, force: true });
