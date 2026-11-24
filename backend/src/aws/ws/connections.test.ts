import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import type { ApiEvent } from "../runtime/http";

test("WebSocket job access uses verified roles and preserves owner checks", async (t) => {
  const modulePath = require.resolve("./connections");
  const cached = require.cache[modulePath];
  const loader = Module as unknown as { _load: (request: string, parent?: { filename?: string }, isMain?: boolean) => unknown };
  const originalLoad = loader._load;
  let claims: Record<string, string> = {}, invalidToken = false, missingJob = false;
  let lookups: string[] = [], registrations = 0, verifications = 0;
  delete require.cache[modulePath];
  loader._load = function (request, parent, isMain) {
    if (parent?.filename === modulePath && request === "../runtime/cognito-jwt") return {
      verifyCognitoJwt: async () => {
        verifications++;
        if (invalidToken) throw new Error("Invalid JWT signature.");
        return claims;
      },
    };
    if (parent?.filename === modulePath && request === "../runtime/workflow-db") return {
      getWorkflowJobById: async () => { lookups.push("admin"); return missingJob ? null : { userId: "service:AR_WORKFLOW" }; },
      getWorkflowJobForUser: async (_jobId: string, userId: string) => {
        lookups.push("owner");
        return userId === "owner" ? { userId } : null;
      },
      registerConnection: async () => { registrations++; },
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  t.mock.method(console, "error", () => {});
  try {
    const { connect } = require("./connections") as typeof import("./connections");
    for (const scenario of [
      { name: "admin token can watch an AR job", sub: "admin", groups: "ADMIN", status: 200, lookup: "admin" },
      { name: "developer token can watch an AR job", sub: "developer", groups: "DEVELOPER", status: 200, lookup: "admin" },
      { name: "owner can watch their job", sub: "owner", groups: "USER", status: 200, lookup: "owner" },
      { name: "ordinary user cannot watch another job", sub: "other", groups: "USER", status: 403, lookup: "owner" },
      { name: "missing job is denied to admin", sub: "admin", groups: "ADMIN", missing: true, status: 403, lookup: "admin" },
      { name: "unverified admin token is rejected", sub: "admin", groups: "ADMIN", invalid: true, status: 401 },
      { name: "API Gateway verified admin can watch an AR job", sub: "admin", groups: "ADMIN", gateway: true, status: 200, lookup: "admin" },
    ]) {
      await t.test(scenario.name, async () => {
        claims = { sub: scenario.sub, "cognito:groups": scenario.groups };
        invalidToken = Boolean(scenario.invalid); missingJob = Boolean(scenario.missing);
        lookups = []; registrations = 0; verifications = 0;
        const event: ApiEvent = { queryStringParameters: { jobId: "job-A", token: "fixture-token" },
          requestContext: { connectionId: "fixture-connection", ...(scenario.gateway ? { authorizer: { jwt: { claims } } } : {}) } };
        assert.equal((await connect(event)).statusCode, scenario.status);
        assert.deepEqual(lookups, scenario.lookup ? [scenario.lookup] : []);
        assert.equal(registrations, scenario.status === 200 ? 1 : 0);
        assert.equal(verifications, scenario.gateway ? 0 : 1);
      });
    }
  } finally {
    loader._load = originalLoad;
    delete require.cache[modulePath];
    if (cached) require.cache[modulePath] = cached;
  }
});
