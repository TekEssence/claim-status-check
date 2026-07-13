import assert from "node:assert/strict";
import { test } from "node:test";
import { formatOptumProErrorReport } from "../log-file";

test("formats Optum Pro error report with failure context and timeline", () => {
  const report = formatOptumProErrorReport([
    {
      timestamp: "2026-06-30T00:00:00.000Z",
      level: "info",
      stage: "open-login",
      message: "Opening login",
      url: "https://pro.optum.com",
    },
  ], {
    jobId: "job-1",
    message: "OTP failed",
    stage: "otp",
    url: "https://identity.onehealthcareid.com/oneapp/index.html#/login",
    pageTitle: "Access Code",
    diagnostics: {
      browserChannel: "chrome",
      browserVersion: "120.0.0.0",
      consoleMessages: ["error: example console error"],
      cookieSummaries: ["sid | domain=.onehealthcareid.com | expires=-1"],
      failedRequests: ["GET https://identity.onehealthcareid.com/api/login | net::ERR_FAILED"],
      httpErrors: ["401 POST https://identity.onehealthcareid.com/api/login"],
      loginApiResponses: ["200 POST https://identity.onehealthcareid.com/api/login-options | body={\"status\":\"FAILURE\",\"message\":\"userExists false\"}"],
      launchedByPlaywright: true,
      localStorageSummaries: ["https://identity.onehealthcareid.com | keys=ohid"],
      profilePath: "data/browser-profiles/optum-pro",
      sessionStorageSummaries: ["https://identity.onehealthcareid.com | keys=none"],
      userAgent: "Mozilla/5.0 Chrome/120.0.0.0",
      usesPersistentProfile: true,
    },
  });

  assert.match(report, /Optum Pro error report/);
  assert.match(report, /jobId=job-1/);
  assert.match(report, /failedStage=otp/);
  assert.match(report, /message=OTP failed/);
  assert.match(report, /INFO \| open-login \| Opening login/);
  assert.match(report, /Browser Diagnostics/);
  assert.match(report, /browserChannel=chrome/);
  assert.match(report, /launchedByPlaywright=true/);
  assert.match(report, /usesPersistentProfile=true/);
  assert.match(report, /profilePath=data\/browser-profiles\/optum-pro/);
  assert.match(report, /Mozilla\/5\.0 Chrome\/120\.0\.0\.0/);
  assert.match(report, /error: example console error/);
  assert.match(report, /sid \| domain=\.onehealthcareid\.com/);
  assert.match(report, /net::ERR_FAILED/);
  assert.match(report, /401 POST/);
  assert.match(report, /Login API Responses/);
  assert.match(report, /userExists false/);
  assert.match(report, /keys=ohid/);
});
