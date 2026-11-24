import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ECSClient, type RunTaskCommand } from "@aws-sdk/client-ecs";
import { login, startForgotPassword, startSignUp } from "./http/auth";
import { runWorkerTask } from "./runtime/ecs";
import { createDownloadUrl, createUploadUrl } from "./runtime/s3";

test("west-region login, sign-up and password recovery use the existing east Cognito pool", async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; });
  process.env.AWS_REGION = "us-west-2";
  process.env.COGNITO_REGION = "us-east-1";
  process.env.COGNITO_CLIENT_ID = "existing-client";
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  t.mock.method(globalThis, "fetch", async (url: string, options: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(options.body)) });
    return new Response(JSON.stringify({ AuthenticationResult: { AccessToken: "access", IdToken: "id" }, UserConfirmed: true }));
  });
  assert.equal((await login({ body: JSON.stringify({ email: "test@example.com", password: "existing-password" }) })).statusCode, 200);
  assert.equal((await startForgotPassword({ body: JSON.stringify({ email: "test@example.com" }) })).statusCode, 200);
  assert.equal((await startSignUp({ body: JSON.stringify({ email: "new@example.com", username: "New User", password: "ExamplePass123", confirmPassword: "ExamplePass123" }) })).statusCode, 200);
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.url, "https://cognito-idp.us-east-1.amazonaws.com/");
    assert.equal(request.body.ClientId, "existing-client");
  }
  delete process.env.COGNITO_REGION;
  await startForgotPassword({ body: JSON.stringify({ email: "test@example.com" }) });
  assert.equal(requests[3].url, "https://cognito-idp.us-west-2.amazonaws.com/");
});

test("west-region API signs upload and download URLs for the existing east S3 buckets", async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; });
  Object.assign(process.env, { AWS_REGION: "us-west-2", WORKFLOW_S3_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "test-access", AWS_SECRET_ACCESS_KEY: "test-secret" });
  const urls = [
    await createUploadUrl({ bucket: "existing-inputs", key: "jobs/test/input.xlsx" }),
    await createDownloadUrl({ bucket: "existing-outputs", key: "jobs/test/output.xlsx" }),
  ];
  for (const value of urls) {
    const url = new URL(value);
    assert.match(url.hostname, /\.s3\.us-east-1\.amazonaws\.com$/);
    assert.match(url.searchParams.get("X-Amz-Credential")!, /\/us-east-1\/s3\/aws4_request$/);
  }
});

test("private west workers launch without public IPs; existing launches retain their default", async (t) => {
  const originalEnv = { ...process.env };
  t.after(() => { process.env = originalEnv; });
  Object.assign(process.env, { WORKER_CLUSTER_ARN: "west-cluster", WORKER_TASK_DEFINITION_ARN: "west-definition", WORKER_SUBNET_IDS: "subnet-123abc,subnet-456def", WORKER_SECURITY_GROUP_IDS: "sg-123abc", WORKER_ASSIGN_PUBLIC_IP: "DISABLED" });
  const requests: RunTaskCommand["input"][] = [];
  t.mock.method(ECSClient.prototype, "send", async (command: RunTaskCommand) => {
    requests.push(command.input);
    return { tasks: [{ taskArn: "worker-task" }] };
  });
  const params = { jobId: "test-job", userId: "existing-user", workflowId: "claim-status", portalId: "iehp", inputBucket: "existing-inputs", outputBucket: "existing-outputs", inputKeys: {} };
  assert.equal(await runWorkerTask(params), "worker-task");
  assert.deepEqual(requests[0].networkConfiguration?.awsvpcConfiguration, { subnets: ["subnet-123abc", "subnet-456def"], securityGroups: ["sg-123abc"], assignPublicIp: "DISABLED" });
  delete process.env.WORKER_ASSIGN_PUBLIC_IP;
  await runWorkerTask(params);
  assert.equal(requests[1].networkConfiguration?.awsvpcConfiguration?.assignPublicIp, "ENABLED");
});

test("west deployment creates its repository before pushing, builds with the new URLs, and stops on failure", () => {
  const source = readFileSync("scripts/deploy-aws-dev.mjs", "utf8").replace('import { spawnSync } from "node:child_process";', "");
  for (const failDeploy of [false, true]) {
    const commands: Array<{ command: string; args: string[]; options: { env: Record<string, string> } }> = [];
    const stopped = new Error("process exited");
    let exitCode: number | undefined;
    assert.throws(() => runInNewContext(source, {
      spawnSync(command: string, args: string[], options: { env: Record<string, string> }) {
        commands.push({ command, args, options });
        return { status: failDeploy ? 1 : 0 };
      },
      console: { log() {}, error() {} },
      process: { argv: ["node", "deploy", "both", "dev-west"], platform: "win32", env: { AWS_REGION: "us-east-1", WORKER_ECR_REPOSITORY: "old-repository", SST_SKIP_FRONTEND_BUILD: "true" }, exit(code: number) { exitCode = code; throw stopped; } },
    }), (error: unknown) => error === stopped);
    assert.equal(exitCode, failDeploy ? 1 : 0);
    assert.equal(commands.length, failDeploy ? 1 : 2);
    assert.equal(commands[0].command, "npx.cmd");
    assert.equal(commands[0].args.join(" "), "sst deploy --stage dev-west");
    assert.equal(commands[0].options.env.AWS_REGION, "us-west-2");
    assert.equal(commands[0].options.env.SST_SKIP_FRONTEND_BUILD, "false");
    if (!failDeploy) {
      assert.equal(commands[1].args.join(" "), "run worker:push:dev");
      assert.equal(commands[1].options.env.WORKER_ECR_REPOSITORY, "claim-status-dev-west-worker");
      assert.equal(commands[1].options.env.SST_STAGE, "dev-west");
    }
  }
});

test("Virginia dev ignores incomplete west RDS settings and stays in us-east-1", async () => {
  const source = ts.transpileModule(readFileSync("sst.config.ts", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const stopped = new Error("First resource reached");
  for (const stage of ["dev", "dev-west"]) {
    let resources = 0;
    const exports: { default?: { app: (input: { stage: string }) => { providers: { aws: { region: string } } }; run: () => Promise<unknown> } } = {};
    runInNewContext(source, {
      exports, process: { env: { AWS_REGION: "us-west-2" } }, $app: { stage }, $config: (config: unknown) => config,
      require(name: string) {
        if (name === "@pulumi/aws") return { getRegionOutput: () => ({ name: "us-east-1" }) };
        if (name === "node:fs") return {
          existsSync: (file: string) => file === ".env.local",
          readFileSync: () => "DATABASE_URL=postgres://fixture:fixture@source/claims\nDATABASE_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:west\n",
        };
        throw new Error(`Unexpected import: ${name}`);
      },
      sst: { aws: { Bucket: class { constructor() { resources++; throw stopped; } } } },
    });
    assert.equal(exports.default!.app({ stage }).providers.aws.region, stage === "dev" ? "us-east-1" : "us-west-2");
    await assert.rejects(exports.default!.run(), (error: unknown) => stage === "dev" ? error === stopped : error instanceof Error ? /Secret-based RDS requires/.test(error.message) : /Secret-based RDS requires/.test(String(error)));
    assert.equal(resources, stage === "dev" ? 1 : 0);
  }
});

test("usual worker push targets Virginia even when AWS_REGION contains the west region", () => {
  const source = readFileSync("scripts/push-worker-dev.mjs", "utf8").replace('import { spawnSync } from "node:child_process";', "");
  const commands: Array<{ command: string; args: string[] }> = [];
  runInNewContext(source, {
    spawnSync(command: string, args: string[]) { commands.push({ command, args }); return { status: 0, stdout: "fixture-login-password" }; },
    console: { log() {}, error() {} },
    process: { env: { AWS_REGION: "us-west-2" }, platform: "win32", exit() { throw new Error("Unexpected failure"); }, stderr: { write() {} } },
  });
  const lookup = commands.find(command => command.args.includes("describe-repositories"))!;
  assert.equal(lookup.args[lookup.args.indexOf("--region") + 1], "us-east-1");
  const push = commands.find(command => command.command === "docker" && command.args[0] === "push")!;
  assert.match(push.args[1], /\.dkr\.ecr\.us-east-1\.amazonaws\.com\/claim-status-dev-worker:dev$/);
});
