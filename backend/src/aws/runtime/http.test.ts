import test from "node:test";
import assert from "node:assert/strict";
import { getAuthRole, hasFullWorkflowAccess, type ApiEvent } from "./http";

function eventWithGroups(groups: unknown): ApiEvent {
  return {
    requestContext: {
      authorizer: {
        jwt: {
          claims: { sub: "developer-user", "cognito:groups": groups as string },
        },
      },
    },
  };
}

test("developer groups are recognized in JWT array and API Gateway string formats", () => {
  for (const groups of ["DEVELOPER", "USER,DEVELOPER", '["USER","DEVELOPER"]', "[DEVELOPER]", ["DEVELOPER"]]) {
    const event = eventWithGroups(groups);
    assert.equal(getAuthRole(event), "DEVELOPER");
    assert.equal(hasFullWorkflowAccess(event), true);
  }
});

test("unprivileged groups do not grant access to all running jobs", () => {
  for (const groups of ["USER", '["USER"]', "[NOT_DEVELOPER]", []]) {
    assert.equal(hasFullWorkflowAccess(eventWithGroups(groups)), false);
  }
});

test("cross-account job lists reject a non-developer instead of returning personal jobs", async () => {
  const { listJobs } = await import("../http/jobs");
  for (const scope of ["all-running", "ar-workflow-outputs"]) {
    const response = await listJobs({
      ...eventWithGroups("USER"),
      queryStringParameters: { scope },
    });
    assert.equal(response.statusCode, 403);
  }
});
