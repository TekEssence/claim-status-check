export type OptumProLogEntry = {
  timestamp: string;
  level: "info" | "warn" | "error";
  stage: string;
  message: string;
  url?: string;
};

export type OptumProBrowserDiagnostics = {
  browserChannel?: string;
  browserChoice?: string;
  browserVersion?: string;
  cdpEndpointConfigured?: boolean;
  cloudFrontErrors?: string[];
  consoleMessages: string[];
  customUserAgentEnabled?: boolean;
  failedRequests: string[];
  forbiddenResponses?: string[];
  headless?: boolean;
  httpErrors: string[];
  launchArgs?: string[];
  loginApiResponses: string[];
  navigationFailures?: string[];
  networkRequests?: string[];
  pageErrors?: string[];
  requestHeaderNames?: string[];
  responseStatuses?: string[];
  redirectChains?: string[];
  launchedByPlaywright?: boolean;
  cookieSummaries?: string[];
  executablePath?: string;
  localStorageSummaries?: string[];
  profilePath?: string;
  sessionStorageSummaries?: string[];
  timeoutMessages?: string[];
  userAgent?: string;
  usesPersistentProfile?: boolean;
  usesSparticuzChromium?: boolean;
};

export function formatOptumProErrorReport(entries: OptumProLogEntry[], error: {
  jobId: string;
  message: string;
  stage: string;
  url?: string;
  pageTitle?: string;
  diagnostics?: OptumProBrowserDiagnostics;
}): string {
  const lines = [
    "Optum Pro error report",
    "",
    `jobId=${error.jobId}`,
    `failedStage=${error.stage}`,
    `message=${error.message}`,
    error.url ? `url=${error.url}` : "",
    error.pageTitle ? `pageTitle=${error.pageTitle}` : "",
    "",
    "Timeline",
  ].filter(Boolean);

  for (const entry of entries) {
    lines.push([
      entry.timestamp,
      entry.level.toUpperCase(),
      entry.stage,
      entry.message,
      entry.url ? `url=${entry.url}` : "",
    ].filter(Boolean).join(" | "));
  }

  if (error.diagnostics) {
    lines.push("", "Browser Diagnostics", "");
    if (error.diagnostics.browserChannel) lines.push(`browserChannel=${error.diagnostics.browserChannel}`);
    if (error.diagnostics.browserChoice) lines.push(`browserChoice=${error.diagnostics.browserChoice}`);
    if (error.diagnostics.browserVersion) lines.push(`browserVersion=${error.diagnostics.browserVersion}`);
    if (error.diagnostics.userAgent) lines.push(`userAgent=${error.diagnostics.userAgent}`);
    if (typeof error.diagnostics.headless === "boolean") lines.push(`headless=${error.diagnostics.headless}`);
    if (typeof error.diagnostics.launchedByPlaywright === "boolean") lines.push(`launchedByPlaywright=${error.diagnostics.launchedByPlaywright}`);
    if (typeof error.diagnostics.usesPersistentProfile === "boolean") lines.push(`usesPersistentProfile=${error.diagnostics.usesPersistentProfile}`);
    if (typeof error.diagnostics.usesSparticuzChromium === "boolean") lines.push(`usesSparticuzChromium=${error.diagnostics.usesSparticuzChromium}`);
    if (typeof error.diagnostics.cdpEndpointConfigured === "boolean") lines.push(`cdpEndpointConfigured=${error.diagnostics.cdpEndpointConfigured}`);
    if (typeof error.diagnostics.customUserAgentEnabled === "boolean") lines.push(`customUserAgentEnabled=${error.diagnostics.customUserAgentEnabled}`);
    if (error.diagnostics.executablePath) lines.push(`executablePath=${error.diagnostics.executablePath}`);
    if (error.diagnostics.profilePath) lines.push(`profilePath=${error.diagnostics.profilePath}`);
    lines.push("", "Launch Args");
    lines.push(...formatDiagnosticLines(error.diagnostics.launchArgs || []));
    lines.push("");
    lines.push("Console Messages");
    lines.push(...formatDiagnosticLines(error.diagnostics.consoleMessages));
    lines.push("", "Page Errors");
    lines.push(...formatDiagnosticLines(error.diagnostics.pageErrors || []));
    lines.push("", "Observed Requests");
    lines.push(...formatDiagnosticLines(error.diagnostics.networkRequests || []));
    lines.push("", "Response Statuses");
    lines.push(...formatDiagnosticLines(error.diagnostics.responseStatuses || []));
    lines.push("", "Redirect Chains");
    lines.push(...formatDiagnosticLines(error.diagnostics.redirectChains || []));
    lines.push("", "Failed Requests");
    lines.push(...formatDiagnosticLines(error.diagnostics.failedRequests));
    lines.push("", "HTTP Error Responses");
    lines.push(...formatDiagnosticLines(error.diagnostics.httpErrors));
    lines.push("", "HTTP 403 Responses");
    lines.push(...formatDiagnosticLines(error.diagnostics.forbiddenResponses || []));
    lines.push("", "CloudFront Errors");
    lines.push(...formatDiagnosticLines(error.diagnostics.cloudFrontErrors || []));
    lines.push("", "Navigation/Timeout Diagnostics");
    lines.push(...formatDiagnosticLines([...(error.diagnostics.navigationFailures || []), ...(error.diagnostics.timeoutMessages || [])]));
    lines.push("", "Login API Responses");
    lines.push(...formatDiagnosticLines(error.diagnostics.loginApiResponses));
    lines.push("", "Request Header Names");
    lines.push(...formatDiagnosticLines(error.diagnostics.requestHeaderNames || []));
    lines.push("", "Cookies Present");
    lines.push(...formatDiagnosticLines(error.diagnostics.cookieSummaries || []));
    lines.push("", "Local Storage");
    lines.push(...formatDiagnosticLines(error.diagnostics.localStorageSummaries || []));
    lines.push("", "Session Storage");
    lines.push(...formatDiagnosticLines(error.diagnostics.sessionStorageSummaries || []));
  }

  return `${lines.join("\n")}\n`;
}

function formatDiagnosticLines(values: string[]): string[] {
  if (!values.length) return ["none captured"];
  return values.map((value) => `- ${value}`);
}
