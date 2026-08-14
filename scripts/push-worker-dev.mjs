import { spawnSync } from "node:child_process";

const accountId = process.env.AWS_ACCOUNT_ID || "033995042643";
const region = process.env.AWS_REGION || "us-east-1";
const profile = process.env.AWS_PROFILE || "claim-status";
const repository = process.env.WORKER_ECR_REPOSITORY || "claim-status-dev-worker";
const localImage = "claim-status-worker:dev";
const registry = `${accountId}.dkr.ecr.${region}.amazonaws.com`;
const remoteImage = `${registry}/${repository}:dev`;

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function capture(command, args) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || "");
    process.exit(result.status ?? 1);
  }
  return result.stdout.trim();
}

run("docker", ["build", "-f", "Dockerfile.worker", "-t", localImage, "."]);

const repositoryCheck = spawnSync("aws", [
  "ecr",
  "describe-repositories",
  "--repository-names",
  repository,
  "--profile",
  profile,
  "--region",
  region,
], {
  encoding: "utf8",
  shell: process.platform === "win32",
});
if (repositoryCheck.status !== 0) {
  console.error(`ECR repository "${repository}" was not found. Run "npx sst deploy --stage dev" once so SST creates it, then run this command again.`);
  process.exit(repositoryCheck.status ?? 1);
}

const password = capture("aws", [
  "ecr",
  "get-login-password",
  "--profile",
  profile,
  "--region",
  region,
]);

console.log(`> docker login --username AWS --password-stdin ${registry}`);
const login = spawnSync("docker", ["login", "--username", "AWS", "--password-stdin", registry], {
  input: password,
  stdio: ["pipe", "inherit", "inherit"],
  shell: process.platform === "win32",
});
if (login.status !== 0) {
  process.exit(login.status ?? 1);
}

run("docker", ["tag", localImage, remoteImage]);
run("docker", ["push", remoteImage]);

console.log(`Worker image pushed: ${remoteImage}`);
