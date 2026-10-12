import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";

test("the IEHP worker starts without the HTTP-only S3 URL signer", async () => {
  const loader = Module as unknown as { _load: (request: string, parent?: unknown, isMain?: boolean) => unknown };
  const originalLoad = loader._load;
  let signerRequested = false;
  loader._load = function (request, parent, isMain) {
    if (request === "@aws-sdk/s3-request-presigner") {
      signerRequested = true;
      throw new Error("HTTP-only S3 URL signer is unavailable in the worker image.");
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    await import("./claim-status-worker");
  } finally {
    loader._load = originalLoad;
  }
  assert.equal(signerRequested, false);
});
