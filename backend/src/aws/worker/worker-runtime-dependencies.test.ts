import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { build } from "esbuild";

test("AWS worker imports only packages installed in its image", async () => {
  const root = process.cwd();
  const runtimePackage = JSON.parse(fs.readFileSync(path.join(root, "worker-runtime/package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const result = await build({
    absWorkingDir: root,
    entryPoints: ["backend/src/aws/worker/claim-status-worker.ts"],
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    metafile: true,
    write: false,
    logLevel: "silent",
  });
  const importedPackages = new Set(
    Object.values(result.metafile.outputs)
      .flatMap((output) => output.imports)
      .filter((entry) => entry.external && !entry.path.startsWith("node:"))
      .map((entry) => entry.path.startsWith("@") ? entry.path.split("/").slice(0, 2).join("/") : entry.path.split("/")[0]),
  );
  const missing = [...importedPackages].filter((name) => !(name in runtimePackage.dependencies)).sort();
  assert.deepEqual(missing, [], `The worker image is missing runtime dependencies: ${missing.join(", ")}`);
});
