import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Page, Response } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { ScraperContext } from "../../workflows/claim-status/types";
import { launchOptumProBrowser, type OptumProBrowserLaunchInfo } from "./browser";
import { runOptumProClaimSearch } from "./claim-status";
import { optumProConfig } from "./config";
import { parseOptumProInput } from "./input";
import { formatOptumProErrorReport, type OptumProBrowserDiagnostics, type OptumProLogEntry } from "./log-file";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatLiveLogTimestamp(date = new Date()): string {
  return date.toLocaleTimeString("en-US", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function writeOptumProLiveLog(level: OptumProLogEntry["level"], message: string): void {
  const normalizedLevel = level.toUpperCase().padEnd(5, " ");
  process.stdout.write(`[${formatLiveLogTimestamp()}] ${normalizedLevel} ${message}\n`);
}

const TRUE_VALUES = new Set(["1", "true", "yes", "y", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "n", "off"]);

function envBoolean(names: string[], fallback: boolean): boolean {
  for (const name of names) {
    const value = process.env[name]?.trim().toLowerCase();
    if (!value) continue;
    if (TRUE_VALUES.has(value)) return true;
    if (FALSE_VALUES.has(value)) return false;
  }
  return fallback;
}

function optumRuntimeDiagnosticsEnabled(): boolean {
  return envBoolean(["OPTUM_PRO_ENABLE_RUNTIME_DIAGNOSTICS", "ENABLE_RUNTIME_DIAGNOSTICS"], false);
}

function optumNetworkLoggingEnabled(): boolean {
  return envBoolean(["OPTUM_PRO_ENABLE_NETWORK_LOGGING", "ENABLE_NETWORK_LOGGING"], false);
}

async function isVisible(page: Page, selector: string, timeout = 1500): Promise<boolean> {
  return page.locator(selector).first().isVisible({ timeout }).catch(() => false);
}

async function waitForActionableInput(page: Page, selector: string, timeout = 30000): Promise<void> {
  await page.waitForFunction((inputSelector) => {
    const element = document.querySelector(inputSelector);
    if (!(element instanceof HTMLInputElement)) return false;

    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const ariaDisabled = element.getAttribute("aria-disabled") === "true";

    return rect.width > 0
      && rect.height > 0
      && style.display !== "none"
      && style.visibility !== "hidden"
      && !element.disabled
      && !ariaDisabled;
  }, selector, { timeout });
}

function maskLogin(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 4) return "*".repeat(trimmed.length);
  return `${trimmed.slice(0, 2)}${"*".repeat(Math.max(trimmed.length - 4, 3))}${trimmed.slice(-2)} (length ${trimmed.length})`;
}

function isOneHealthcareIdUrl(url: string): boolean {
  return new URL(url).hostname.includes("identity.onehealthcareid.com");
}

async function visibleText(page: Page, selector: string): Promise<string> {
  const locators = page.locator(selector);
  const count = await locators.count().catch(() => 0);
  for (let index = 0; index < count; index++) {
    const locator = locators.nth(index);
    if (!(await locator.isVisible({ timeout: 300 }).catch(() => false))) continue;
    const text = await locator.innerText({ timeout: 500 }).catch(() => "");
    if (text.trim()) return text.replace(/\s+/g, " ").trim();
  }
  return "";
}

async function humanPause(page: Page, ms = 350): Promise<void> {
  await page.waitForTimeout(ms);
}

async function fillLikeHuman(page: Page, selector: string, value: string, options: { secret?: boolean } = {}): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.click();
  await humanPause(page, 250);
  await page.keyboard.press("Control+A");
  await humanPause(page, 120);
  await page.keyboard.press("Backspace");
  await humanPause(page, 180);

  const delay = options.secret ? 80 : 115;
  await locator.pressSequentially(value, { delay });
  await humanPause(page, 300);
}

async function typeOptumUsernameLikeUhc(page: Page, username: string): Promise<string> {
  const selector = optumProConfig.selectors.username;
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 45000 });

  let actual = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    await locator.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await page.type(selector, username, { delay: 80 });

    actual = await locator.inputValue({ timeout: 3000 }).catch(() => "");
    if (actual === username) return actual;

    await page.waitForTimeout(500);
  }

  return actual;
}

async function usernameFieldReadonly(page: Page): Promise<boolean> {
  return page.locator(optumProConfig.selectors.username).first().evaluate((element) => {
    if (!(element instanceof HTMLInputElement)) return false;
    return element.readOnly || element.getAttribute("aria-readonly") === "true";
  }).catch(() => false);
}

async function usernameStepProgressState(page: Page, initialUrl: string): Promise<string> {
  if (await isVisible(page, optumProConfig.selectors.password, 300)) return "password field is visible";
  if (await isVisible(page, optumProConfig.selectors.verifyOptions, 300)) return "verification options are visible";
  if (await isVisible(page, optumProConfig.selectors.otpInput, 300)) return "OTP input is visible";
  if (await usernameFieldReadonly(page)) return "username field is readonly";
  if (!(await isVisible(page, optumProConfig.selectors.username, 300))) return "username field is no longer visible";

  const currentUrl = page.url();
  if (currentUrl !== initialUrl && !currentUrl.includes("login-options")) {
    return "page URL changed after username submission";
  }

  const pageTitle = await visibleText(page, optumProConfig.selectors.pageTitle).catch(() => "");
  if (pageTitle && !/sign in|one healthcare id|username|email/i.test(pageTitle)) {
    return `page title changed to "${pageTitle}"`;
  }

  return "";
}

async function waitForUsernameStepProgress(page: Page, initialUrl: string, timeout = 30000): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const state = await usernameStepProgressState(page, initialUrl);
    if (state) return state;
    await page.waitForTimeout(300);
  }
  return "";
}

async function waitForPasswordOrUsernameError(page: Page, timeout = 30000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await isVisible(page, optumProConfig.selectors.password, 500)) {
      return;
    }

    const usernameError = await visibleText(page, optumProConfig.selectors.usernameError);
    if (usernameError) {
      throw new Error(`Optum Pro rejected the One Healthcare ID before password entry: ${usernameError}`);
    }

    await page.waitForTimeout(300);
  }
  throw new Error("Timed out waiting for Optum Pro password page or username validation message.");
}

async function waitForNextAuthStep(page: Page, timeout = 60000): Promise<"verify-options" | "otp" | "home"> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (await isVisible(page, optumProConfig.selectors.verifyOptions, 500)) {
      return "verify-options";
    }
    if (await isVisible(page, optumProConfig.selectors.otpInput, 500)) {
      return "otp";
    }

    const loginFieldsAreGone = !(await isVisible(page, optumProConfig.selectors.username, 300))
      && !(await isVisible(page, optumProConfig.selectors.password, 300));
    if (loginFieldsAreGone && !isOneHealthcareIdUrl(page.url())) {
      return "home";
    }

    await page.waitForTimeout(300);
  }
  throw new Error("Timed out waiting for Optum Pro verification options, OTP entry, or post-login redirect.");
}

async function requestOptumOtp(context: ScraperContext): Promise<string> {
  const timeoutMs = 300000;
  await context.emit({
    type: "input_request",
    inputName: "optum_pro_otp",
    label: "Optum Pro text message OTP",
    message: "Enter the One Healthcare ID access code sent by text message within 5 minutes.",
    timeoutMs,
  });
  return waitForScrapeJobInput(context.jobId, "optum_pro_otp", timeoutMs);
}

async function waitForPostLogin(page: Page): Promise<void> {
  await Promise.race([
    page.waitForURL((url) => !url.hostname.includes("identity.onehealthcareid.com"), { timeout: 60000 }),
    page.locator(optumProConfig.selectors.otpInput).first().waitFor({ state: "hidden", timeout: 60000 }),
  ]).catch(() => {});

  if (await isVisible(page, optumProConfig.selectors.otpInput, 2000)) {
    throw new Error("Optum Pro OTP was submitted, but the access-code page is still visible.");
  }
}

function downloadableTextFileEvent(filename: string, content: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: Buffer.from(content, "utf8").toString("base64"),
    mimeType: "text/plain",
  };
}

function downloadableBinaryFileEvent(filename: string, content: Buffer, mimeType: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: content.toString("base64"),
    mimeType,
  };
}

async function stopAndEmitOptumTrace(page: Page, context: ScraperContext): Promise<boolean> {
  const traceDir = path.join(process.cwd(), "data", "optum-pro-traces");
  await fs.mkdir(traceDir, { recursive: true });
  const tracePath = path.join(traceDir, `${context.jobId}.zip`);
  await page.context().tracing.stop({ path: tracePath });
  const traceBuffer = await fs.readFile(tracePath);
  await context.emit(downloadableBinaryFileEvent("optum-pro-trace.zip", traceBuffer, "application/zip"));
  return true;
}

function sanitizeDiagnosticUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value.split("?")[0]?.split("#")[0] || value;
  }
}

function addCappedDiagnosticValue(values: string[], value: string, maxValues = 30): void {
  const cleanValue = value.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!cleanValue || values.includes(cleanValue)) return;
  if (values.length >= maxValues) values.shift();
  values.push(cleanValue);
}

function watchForOptumAuthResponse(page: Page, pathFragment: string, timeout = 10000): Promise<Response | null> {
  return page.waitForResponse((response) => response.url().includes(pathFragment), { timeout }).catch(() => null);
}

async function safeResponseBody(response: Response, maxLength = 4000): Promise<string> {
  const body = await response.text().catch((error) => `Unable to read response body: ${errorMessage(error)}`);
  return body.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

async function navigateAndWaitForOptumLoginInitialization(
  page: Page,
  loginUrl: string,
  stageLog: (level: OptumProLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>,
  diagnostics: OptumProBrowserDiagnostics,
): Promise<void> {
  await stageLog("info", "open-login", `Opening Optum Pro login URL for UI-based initialization: ${loginUrl}.`);
  await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((error) => {
    const diagnostic = `goto ${sanitizeDiagnosticUrl(loginUrl)} | ${errorMessage(error)}`;
    addCappedDiagnosticValue(diagnostics.navigationFailures ||= [], diagnostic);
    if (/timeout/i.test(errorMessage(error))) addCappedDiagnosticValue(diagnostics.timeoutMessages ||= [], diagnostic);
    throw error;
  });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(async (error) => {
    const diagnostic = `networkidle ${sanitizeDiagnosticUrl(page.url())} | ${errorMessage(error)}`;
    addCappedDiagnosticValue(diagnostics.timeoutMessages ||= [], diagnostic);
    await stageLog("warn", "open-login", `Network idle timed out after DOM content loaded; continuing with UI wait. ${errorMessage(error)}`);
  });
  await waitForActionableInput(page, optumProConfig.selectors.username, 45000).catch((error) => {
    const diagnostic = `username wait ${sanitizeDiagnosticUrl(page.url())} | ${errorMessage(error)}`;
    addCappedDiagnosticValue(diagnostics.timeoutMessages ||= [], diagnostic);
    throw error;
  });
  await stageLog("info", "login-init", "Optum username field is visible; waiting 2000ms for login page stabilization.");
  await page.waitForTimeout(2000);
}

function readStringPropertyDeep(value: unknown, keys: string[], depth = 0): string {
  if (!value || typeof value !== "object" || depth > 4) return "";
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = readStringPropertyDeep(item, keys, depth + 1);
      if (nested) return nested;
    }
    return "";
  }

  const record = value as Record<string, unknown>;
  for (const [key, candidate] of Object.entries(record)) {
    if (keys.includes(key) && typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  for (const candidate of Object.values(record)) {
    const nested = readStringPropertyDeep(candidate, keys, depth + 1);
    if (nested) return nested;
  }
  return "";
}

function readBooleanPropertyDeep(value: unknown, keys: string[], depth = 0): boolean | null {
  if (!value || typeof value !== "object" || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = readBooleanPropertyDeep(item, keys, depth + 1);
      if (nested !== null) return nested;
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  for (const [key, candidate] of Object.entries(record)) {
    if (!keys.includes(key)) continue;
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "string") {
      const normalized = candidate.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  for (const candidate of Object.values(record)) {
    const nested = readBooleanPropertyDeep(candidate, keys, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function summarizeLoginOptionsBody(body: string): { status: string; message: string; userExists: boolean | null } {
  try {
    const parsed = JSON.parse(body) as unknown;
    const status = readStringPropertyDeep(parsed, ["status", "result", "outcome"]);
    const message = readStringPropertyDeep(parsed, ["message", "errorMessage", "error", "description", "detail"]);
    const userExists = readBooleanPropertyDeep(parsed, ["userExists", "userExistsFlag"]);
    return {
      status: status || "UNKNOWN",
      message,
      userExists,
    };
  } catch {
    return {
      status: body.includes("SUCCESS") ? "SUCCESS" : body.includes("FAILURE") ? "FAILURE" : "UNKNOWN",
      message: "",
      userExists: null,
    };
  }
}

function addLoginApiDiagnostic(diagnostics: OptumProBrowserDiagnostics, response: Response, body: string): void {
  const headerNames = Object.keys(response.request().headers()).sort();
  addCappedDiagnosticValue(
    diagnostics.loginApiResponses,
    `${response.status()} ${response.request().method()} ${sanitizeDiagnosticUrl(response.url())} | requestHeaderNames=${headerNames.join(", ") || "none"} | body=${body}`,
    10,
  );
  diagnostics.requestHeaderNames ||= [];
  addCappedDiagnosticValue(
    diagnostics.requestHeaderNames,
    `${response.request().method()} ${sanitizeDiagnosticUrl(response.url())} | ${headerNames.join(", ") || "none"}`,
    10,
  );
}

function requestHeaderNameSummary(response: Response): string {
  const headerNames = Object.keys(response.request().headers()).sort();
  return headerNames.join(", ") || "none";
}

function redirectChainForResponse(response: Response): string {
  const chain: string[] = [];
  let request = response.request();
  while (request) {
    chain.unshift(`${request.method()} ${sanitizeDiagnosticUrl(request.url())}`);
    const redirectedFrom = request.redirectedFrom();
    if (!redirectedFrom) break;
    request = redirectedFrom;
  }
  return chain.join(" -> ");
}

async function addCloudFrontDiagnosticIfPresent(diagnostics: OptumProBrowserDiagnostics, response: Response): Promise<void> {
  const status = response.status();
  if (status < 400) return;

  const headers = response.headers();
  const responseHeaderText = Object.entries(headers)
    .filter(([name]) => ["server", "via", "x-cache", "x-amz-cf-id", "x-amz-cf-pop"].includes(name.toLowerCase()))
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  let bodyHint = "";
  const contentType = headers["content-type"] || "";
  if (/text|html|json/i.test(contentType)) {
    const body = await response.text().catch(() => "");
    bodyHint = /cloudfront/i.test(body) ? "body mentions CloudFront" : "";
  }

  if (!/cloudfront/i.test(responseHeaderText) && !bodyHint) return;
  const request = response.request();
  addCappedDiagnosticValue(
    diagnostics.cloudFrontErrors ||= [],
    `${status} ${request.method()} ${sanitizeDiagnosticUrl(response.url())} | ${responseHeaderText || bodyHint}`,
  );
}

function attachOptumProBrowserDiagnostics(
  page: Page,
  diagnostics: OptumProBrowserDiagnostics,
  logDiagnostic?: (level: OptumProLogEntry["level"], message: string) => Promise<void>,
): void {
  const runtimeDiagnosticsEnabled = optumRuntimeDiagnosticsEnabled();
  const networkLoggingEnabled = optumNetworkLoggingEnabled();

  page.on("console", (message) => {
    const type = message.type();
    if (!runtimeDiagnosticsEnabled && !["error", "warning"].includes(type)) return;
    const diagnostic = `${type}: ${message.text()}`;
    addCappedDiagnosticValue(diagnostics.consoleMessages, diagnostic);
    if (runtimeDiagnosticsEnabled && ["error", "warning"].includes(type)) {
      void logDiagnostic?.(type === "error" ? "error" : "warn", `Optum console ${diagnostic}`);
    }
  });

  page.on("pageerror", (error) => {
    if (!runtimeDiagnosticsEnabled) return;
    const diagnostic = errorMessage(error);
    addCappedDiagnosticValue(diagnostics.pageErrors ||= [], diagnostic);
    void logDiagnostic?.("error", `Optum page error: ${diagnostic}`);
  });

  page.on("framenavigated", (frame) => {
    if (!runtimeDiagnosticsEnabled || frame !== page.mainFrame()) return;
    addCappedDiagnosticValue(diagnostics.redirectChains ||= [], `main-frame navigated ${sanitizeDiagnosticUrl(frame.url())}`);
  });

  page.on("request", (request) => {
    if (!networkLoggingEnabled) return;
    const headerNames = Object.keys(request.headers()).sort().join(", ") || "none";
    const diagnostic = `${request.method()} ${sanitizeDiagnosticUrl(request.url())} | type=${request.resourceType()} | requestHeaderNames=${headerNames}`;
    addCappedDiagnosticValue(diagnostics.networkRequests ||= [], diagnostic, 80);
  });

  page.on("requestfailed", (request) => {
    const failure = request.failure();
    const diagnostic = `${request.method()} ${sanitizeDiagnosticUrl(request.url())} | ${failure?.errorText || "request failed"}`;
    addCappedDiagnosticValue(diagnostics.failedRequests, diagnostic);
    if (/timeout/i.test(failure?.errorText || "")) addCappedDiagnosticValue(diagnostics.timeoutMessages ||= [], diagnostic);
    if (runtimeDiagnosticsEnabled) void logDiagnostic?.("warn", `Optum failed request: ${diagnostic}`);
  });

  page.on("response", (response) => {
    const status = response.status();
    const request = response.request();
    if (runtimeDiagnosticsEnabled) {
      addCappedDiagnosticValue(
        diagnostics.responseStatuses ||= [],
        `${status} ${request.method()} ${sanitizeDiagnosticUrl(response.url())} | type=${request.resourceType()} | requestHeaderNames=${requestHeaderNameSummary(response)}`,
        80,
      );

      const redirectChain = redirectChainForResponse(response);
      if (redirectChain.includes(" -> ")) addCappedDiagnosticValue(diagnostics.redirectChains ||= [], redirectChain, 40);
    }

    if (status === 403) {
      const diagnostic = `${status} ${request.method()} ${sanitizeDiagnosticUrl(response.url())}`;
      addCappedDiagnosticValue(diagnostics.forbiddenResponses ||= [], diagnostic);
    }

    void addCloudFrontDiagnosticIfPresent(diagnostics, response);

    if (status < 400) return;
    const diagnostic = `${status} ${request.method()} ${sanitizeDiagnosticUrl(response.url())}`;
    addCappedDiagnosticValue(diagnostics.httpErrors, diagnostic);
    if (runtimeDiagnosticsEnabled) void logDiagnostic?.("warn", `Optum HTTP error response: ${diagnostic}`);
  });
}

async function submitOptumUsernameWithRetries(
  page: Page,
  username: string,
  diagnostics: OptumProBrowserDiagnostics,
  stageLog: (level: OptumProLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>,
): Promise<void> {
  let lastErrorText = "";
  const initialUrl = page.url();

  for (let attempt = 1; attempt <= 3; attempt++) {
    const staleErrorText = await visibleText(page, optumProConfig.selectors.usernameError).catch(() => "");
    if (staleErrorText) {
      await stageLog("warn", "username", `Ignoring stale username error before retry ${attempt}: ${staleErrorText}`);
    }

    await stageLog("info", "username", `Typing normalized One Healthcare ID with delayed keystrokes. Attempt ${attempt}/3.`);
    const enteredUsername = await typeOptumUsernameLikeUhc(page, username);
    await stageLog("info", "username", `Browser username input value after typing: ${enteredUsername}.`);
    if (enteredUsername !== username) {
      throw new Error(`Optum Pro username field value mismatch. Expected ${username}, browser contains ${enteredUsername}.`);
    }

    await stageLog("info", "username", "Waiting 2000ms before clicking Continue for Optum login page stabilization.");
    await page.waitForTimeout(2000);

    const loginOptionsResponsePromise = watchForOptumAuthResponse(page, "/api/v1/auth/login-options", 30000);
    await page.locator(optumProConfig.selectors.usernameSubmit).first().click();

    const loginOptionsResponse = await loginOptionsResponsePromise;

    if (loginOptionsResponse) {
      const responseBody = await safeResponseBody(loginOptionsResponse);
      const loginOptionsSummary = summarizeLoginOptionsBody(responseBody);
      addLoginApiDiagnostic(diagnostics, loginOptionsResponse, responseBody);
      await stageLog(
        "info",
        "login-options",
        `/api/v1/auth/login-options completed with HTTP ${loginOptionsResponse.status()}, status ${loginOptionsSummary.status}, userExists=${loginOptionsSummary.userExists}.`,
      );
      await stageLog("info", "login-options", `/api/v1/auth/login-options response body: ${responseBody}`);

      if (loginOptionsSummary.status.toUpperCase() === "SUCCESS" && loginOptionsSummary.userExists === true) {
        await stageLog("info", "username", "Optum username step accepted by /api/v1/auth/login-options.");
        return;
      }

      lastErrorText = loginOptionsSummary.message || responseBody;
      await stageLog(
        "error",
        "username",
        `Optum rejected the username in /api/v1/auth/login-options: status=${loginOptionsSummary.status}, userExists=${loginOptionsSummary.userExists}${lastErrorText ? `, message=${lastErrorText}` : ""}.`,
      );
      throw new Error(`Optum Pro rejected the One Healthcare ID before password entry${lastErrorText ? `: ${lastErrorText}` : ""}`);
    } else {
      await stageLog("warn", "login-options", "Timed out waiting for /api/v1/auth/login-options response after username submit; checking UI progression.");
    }

    const finalProgressState = await waitForUsernameStepProgress(page, initialUrl, 30000);
    if (finalProgressState) {
      await stageLog("info", "username", `Optum username step accepted: ${finalProgressState}.`);
      return;
    }

    const currentErrorText = await visibleText(page, optumProConfig.selectors.usernameError).catch(() => "");
    if (currentErrorText && currentErrorText !== staleErrorText) {
      lastErrorText = currentErrorText;
      await stageLog("warn", "username", `Optum username submit attempt ${attempt}/3 showed error: ${currentErrorText}`);
    } else {
      await stageLog("warn", "username", `Optum username submit attempt ${attempt}/3 did not reach the next authentication screen.`);
    }

    if (attempt < 3) {
      await page.waitForTimeout(1500);
    }
  }

  throw new Error(`Optum Pro username step did not reach the next authentication screen after 3 attempts${lastErrorText ? `: ${lastErrorText}` : ""}.`);
}

function applyOptumProLaunchDiagnostics(diagnostics: OptumProBrowserDiagnostics, launchInfo: OptumProBrowserLaunchInfo): void {
  diagnostics.browserChannel = launchInfo.browserChannel;
  diagnostics.browserChoice = launchInfo.browserChoice;
  diagnostics.cdpEndpointConfigured = launchInfo.cdpEndpointConfigured;
  diagnostics.customUserAgentEnabled = launchInfo.customUserAgentEnabled;
  diagnostics.executablePath = launchInfo.executablePath;
  diagnostics.headless = launchInfo.headless;
  diagnostics.launchArgs = launchInfo.launchArgs;
  diagnostics.launchedByPlaywright = launchInfo.launchedByPlaywright;
  diagnostics.profilePath = launchInfo.persistentProfilePath;
  diagnostics.usesPersistentProfile = launchInfo.usesPersistentProfile;
  diagnostics.usesSparticuzChromium = launchInfo.usesSparticuzChromium;
}

async function collectOptumProPageDiagnostics(page: Page, diagnostics: OptumProBrowserDiagnostics): Promise<void> {
  const browserVersion = page.context().browser()?.version();
  if (browserVersion) diagnostics.browserVersion = browserVersion;

  const userAgent = await page.evaluate(() => window.navigator.userAgent).catch(() => "");
  if (userAgent) diagnostics.userAgent = userAgent;

  const cookies = await page.context().cookies().catch(() => []);
  diagnostics.cookieSummaries = cookies
    .map((cookie) => `${cookie.name} | domain=${cookie.domain} | expires=${cookie.expires}`)
    .sort();

  const storageSummary = await page.evaluate(() => ({
    origin: window.location.origin,
    localStorageKeys: Object.keys(window.localStorage).sort(),
    sessionStorageKeys: Object.keys(window.sessionStorage).sort(),
  })).catch(() => null);

  if (storageSummary) {
    diagnostics.localStorageSummaries = [
      `${storageSummary.origin} | keys=${storageSummary.localStorageKeys.length ? storageSummary.localStorageKeys.join(", ") : "none"}`,
    ];
    diagnostics.sessionStorageSummaries = [
      `${storageSummary.origin} | keys=${storageSummary.sessionStorageKeys.length ? storageSummary.sessionStorageKeys.join(", ") : "none"}`,
    ];
  }
}

async function emitOptumProDiagnostics(context: ScraperContext, page: Page, stage: string): Promise<{
  htmlEmitted: boolean;
  screenshotEmitted: boolean;
}> {
  const safeStage = stage.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "error";
  let htmlEmitted = false;
  let screenshotEmitted = false;

  const html = await page.content().catch(() => "");
  if (html) {
    htmlEmitted = true;
    await context.emit({
      type: "debug_html",
      index: 0,
      html,
      filename: `optum_pro_${safeStage}.html`,
    });
  }

  const screenshot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  if (screenshot) {
    screenshotEmitted = true;
    await context.emit({
      type: "error_screenshot",
      index: 0,
      image: screenshot.toString("base64"),
      filename: `optum_pro_${safeStage}.jpg`,
    });
  }

  return { htmlEmitted, screenshotEmitted };
}

export async function runOptumProLoginJob(formData: FormData, context: ScraperContext): Promise<void> {
  const startedAt = Date.now();
  const input = await parseOptumProInput(formData);
  let browser: Browser | null | undefined;
  let page: Page | undefined;
  let currentStage = "initializing";
  let traceStarted = false;
  let traceEmitted = false;
  const logEntries: OptumProLogEntry[] = [];
  const browserDiagnostics: OptumProBrowserDiagnostics = {
    cloudFrontErrors: [],
    consoleMessages: [],
    failedRequests: [],
    forbiddenResponses: [],
    httpErrors: [],
    loginApiResponses: [],
    navigationFailures: [],
    networkRequests: [],
    pageErrors: [],
    requestHeaderNames: [],
    redirectChains: [],
    responseStatuses: [],
    timeoutMessages: [],
  };

  const stageLog = async (level: OptumProLogEntry["level"], stage: string, message: string, currentPage = page) => {
    currentStage = stage;
    const url = currentPage?.url();
    const logMessage = `[${stage}] ${message}${url ? ` Current URL: ${url}` : ""}`;
    logEntries.push({
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      url,
    });
    writeOptumProLiveLog(level, logMessage);
    await context.log({ level, message: logMessage });
  };

  const contextLog = async (level: OptumProLogEntry["level"], message: string) => {
    writeOptumProLiveLog(level, message);
    await context.log({ level, message });
  };

  const log = async (message: string) => stageLog("info", currentStage, message);

  try {
    await stageLog("info", "started", "Starting Optum Pro automation.");
    await context.emit({ type: "progress", completed: 0, total: input.rows.length });

    currentStage = "browser-launch";
    await stageLog("info", "browser-launch", "Launching Optum Pro browser.");
    const session = await launchOptumProBrowser(log);
    browser = session.browser;
    applyOptumProLaunchDiagnostics(browserDiagnostics, session.launchInfo);
    page = await session.context.newPage();
    await stageLog("info", "browser-launch", "Browser page created.");
    attachOptumProBrowserDiagnostics(page, browserDiagnostics, contextLog);
    page.setDefaultTimeout(30000);

    await stageLog("info", "trace", "Starting Optum Pro Playwright trace before opening the login URL.");
    await session.context.tracing.start({
      screenshots: true,
      snapshots: true,
      sources: true,
    });
    traceStarted = true;

    await stageLog("info", "open-login", `Opening Optum Pro login URL: ${input.credentials.loginUrl}`);
    await navigateAndWaitForOptumLoginInitialization(page, input.credentials.loginUrl, stageLog, browserDiagnostics);
    await stageLog("info", "login-init", "Login page loaded.");

    const normalizedUsername = input.credentials.username.trim().toLowerCase();
    await submitOptumUsernameWithRetries(page, normalizedUsername, browserDiagnostics, stageLog);
    await stageLog("info", "username", "Username entered.");

    await waitForPasswordOrUsernameError(page);
    await stageLog("info", "password", "Filling One Healthcare ID password.");
    await fillLikeHuman(page, optumProConfig.selectors.password, input.credentials.password, { secret: true });
    await stageLog("info", "password", "Password entered.");
    await humanPause(page, 650);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      page.locator(optumProConfig.selectors.passwordSubmit).first().click(),
    ]);
    await stageLog("info", "password", "Login button clicked.");
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    await stageLog("info", "auth", "Waiting for authentication.");
    const nextStep = await waitForNextAuthStep(page);

    if (nextStep === "verify-options") {
      await stageLog("info", "mfa-method", "Selecting Optum Pro text-message verification.");
      await page.locator(optumProConfig.selectors.textMessageOption).first().click();
      await page.locator(optumProConfig.selectors.otpInput).first().waitFor({ state: "visible", timeout: 30000 });
    }

    if (await isVisible(page, optumProConfig.selectors.otpInput, 3000)) {
      await stageLog("info", "otp", "Waiting for manual Optum Pro OTP entry.");
      const otp = await requestOptumOtp(context);
      await stageLog("info", "otp", "Submitting Optum Pro OTP.");
      await fillLikeHuman(page, optumProConfig.selectors.otpInput, otp, { secret: true });
      await humanPause(page, 650);
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        page.locator(optumProConfig.selectors.otpSubmit).first().click(),
      ]);
      await waitForPostLogin(page);
    }

    await stageLog("info", "completed", `Login successful. Current URL: ${page.url()}`);
    await runOptumProClaimSearch(page, input.rows, context, stageLog);
    if (traceStarted && page) {
      traceStarted = false;
      traceEmitted = await stopAndEmitOptumTrace(page, context).catch(() => false);
    }
    await context.emit({ type: "done" });
  } catch (error) {
    const message = errorMessage(error);
    await stageLog("error", currentStage, `Login failed: ${message}`);
    let pageTitle = "";
    let diagnosticSummary = "No page diagnostics were available because the browser page was not created.";
    if (page) {
      await collectOptumProPageDiagnostics(page, browserDiagnostics);
      pageTitle = await page.locator(optumProConfig.selectors.pageTitle).first().innerText({ timeout: 1500 }).catch(() => "");
      const diagnostics = await emitOptumProDiagnostics(context, page, currentStage);
      if (diagnostics.screenshotEmitted) {
        await stageLog("info", "diagnostics", "Screenshot captured.");
      }
      diagnosticSummary = [
        diagnostics.screenshotEmitted ? "error screenshot emitted" : "",
        diagnostics.htmlEmitted ? "debug HTML emitted" : "",
      ].filter(Boolean).join(", ") || "page diagnostics attempted, but no artifacts were captured";

      if (traceStarted) {
        traceStarted = false;
        traceEmitted = await stopAndEmitOptumTrace(page, context).catch(() => false);
      }
    }
    const report = formatOptumProErrorReport(logEntries, {
      jobId: context.jobId,
      message,
      stage: currentStage,
      url: page?.url(),
      pageTitle,
      diagnostics: browserDiagnostics,
    });
    await context.emit(downloadableTextFileEvent("optum-pro-error-report.log", `${report}\nDiagnostics: ${diagnosticSummary}\n`));
    if (traceEmitted) {
      await context.emit({ type: "warning", message: "Optum Pro trace generated. Download optum-pro-trace.zip for details." });
    }
    await context.emit({ type: "warning", message: "Optum Pro error report generated. Download optum-pro-error-report.log for details." });
    await context.emit({ type: "error", message });
    await context.emit({ type: "done" });
  } finally {
    await closeAutomationResources({
      browser,
      page,
      log: (message) => contextLog("info", message),
    });
    await contextLog("info", "Browser closed.");
    await contextLog("info", `Automation completed. Total execution time: ${Date.now() - startedAt}ms.`);
  }
}
