import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const outDir = "out";
const indexFile = join(outDir, "index.html");

if (!existsSync(outDir) || !statSync(outDir).isDirectory()) {
  console.error('Static frontend output folder "out" does not exist. Run "npm.cmd run build:static" before deploying with SST_SKIP_FRONTEND_BUILD=true.');
  process.exit(1);
}

if (!existsSync(indexFile)) {
  console.error('Static frontend output is missing "out/index.html". Run "npm.cmd run build:static" before deploying with SST_SKIP_FRONTEND_BUILD=true.');
  process.exit(1);
}

console.log("Using existing static frontend build from out/.");
