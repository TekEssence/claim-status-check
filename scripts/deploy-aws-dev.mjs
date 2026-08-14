import { spawnSync } from "node:child_process";

const validTargets = new Set(["worker", "frontend", "both", "all"]);
const target = (process.argv[2] || "both").toLowerCase();

if (!validTargets.has(target)) {
  console.error("Usage: npm.cmd run deploy:aws:dev -- [worker|frontend|both]");
  console.error("  worker   Build/push worker image, then deploy SST.");
  console.error("  frontend Build static frontend, then deploy SST.");
  console.error("  both     Build/push worker and build frontend, then deploy SST. Default.");
  process.exit(1);
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const shouldPushWorker = target === "worker" || target === "both" || target === "all";
const shouldBuildFrontend = target === "frontend" || target === "both" || target === "all";

function run(command, args, options = {}) {
  console.log(`\n> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(`AWS dev deploy target: ${target === "all" ? "both" : target}`);

if (shouldPushWorker) {
  run(npmCommand, ["run", "worker:push:dev"]);
}

if (shouldBuildFrontend) {
  run(npmCommand, ["run", "build:static:aws:dev"]);
}

run(npxCommand, ["sst", "deploy", "--stage", "dev"], {
  env: {
    ...process.env,
    SST_SKIP_FRONTEND_BUILD: "true",
  },
});
