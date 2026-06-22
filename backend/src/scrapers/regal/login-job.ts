import type { Browser, BrowserContext, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { ScraperContext } from "../types";
import { launchRegalBrowser } from "./browser";
import { regalConfig } from "./config";
import { parseRegalInput } from "./input";
import { formatRegalLog, saveRegalLatestLog, type RegalLogEntry } from "./log-file";
import { generateRegalTotpCode } from "./totp";

type DiagnosticEvent = {
  type: "debug_html" | "diagnostic_screenshot" | "error_screenshot";
  index: number;
  html?: string;
  image?: string;
  filename?: string;
};

type FileDownloadEvent = {
  type: "file_download";
  filename: string;
  base64: string;
  mimeType: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function emitPageDiagnostics(context: ScraperContext, page: Page, label: string, options: { error?: boolean } = {}): Promise<void> {
  const safeLabel = label.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 80) || "regal";
  const html = await page.content().catch(() => "");
  if (html) {
    await context.emit({
      type: "debug_html",
      index: 0,
      html,
      filename: `regal_${safeLabel}.html`,
    } satisfies DiagnosticEvent);
  }

  const screenshot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  if (screenshot) {
    await context.emit({
      type: options.error ? "error_screenshot" : "diagnostic_screenshot",
      index: 0,
      image: screenshot.toString("base64"),
      filename: `regal_${safeLabel}.jpg`,
    } satisfies DiagnosticEvent);
  }
}

async function fillUsername(page: Page, username: string): Promise<void> {
  const usernameInput = page.locator(regalConfig.selectors.username).first();
  await usernameInput.waitFor({ state: "visible", timeout: 30000 });
  await usernameInput.fill("");
  await usernameInput.fill(username);

  const actualValue = await usernameInput.inputValue();
  if (actualValue !== username) {
    throw new Error("Regal username field did not contain the configured username after fill.");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.locator(regalConfig.selectors.usernameSubmit).first().click(),
  ]);
}

async function fillPassword(page: Page, password: string): Promise<void> {
  const passwordInput = page.locator(regalConfig.selectors.password).first();
  await passwordInput.waitFor({ state: "visible", timeout: 30000 });
  await passwordInput.fill("");
  await passwordInput.fill(password);

  const actualValue = await passwordInput.inputValue();
  if (actualValue !== password) {
    throw new Error("Regal password field did not contain the configured password after fill.");
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.locator(regalConfig.selectors.passwordSubmit).first().click(),
  ]);
}

async function detectVisibleError(page: Page, timeout = 2000): Promise<string> {
  const errorContainer = page.locator(regalConfig.selectors.errorContainer).first();
  const text = await errorContainer.innerText({ timeout }).catch(() => "");
  return text.trim();
}

function downloadableTextFileEvent(filename: string, content: string): FileDownloadEvent {
  return {
    type: "file_download",
    filename,
    base64: Buffer.from(content, "utf8").toString("base64"),
    mimeType: "text/plain",
  };
}

async function assertRegalDashboard(page: Page): Promise<void> {
  await Promise.race([
    page.locator(regalConfig.selectors.dashboardHeading).first().waitFor({ state: "visible", timeout: 30000 }),
    page.locator(regalConfig.selectors.dashboardText).first().waitFor({ state: "visible", timeout: 30000 }),
    page.locator(regalConfig.selectors.myAppsHeading).first().waitFor({ state: "visible", timeout: 30000 }),
    page.locator(regalConfig.selectors.myAppsText).first().waitFor({ state: "visible", timeout: 30000 }),
  ]);
  await page.locator(regalConfig.selectors.signOut).first().waitFor({ state: "attached", timeout: 30000 });
}

async function launchRegalExpressAccess(page: Page, browserContext: BrowserContext): Promise<Page> {
  const appCard = page.locator(regalConfig.selectors.regalExpressAccessApp).first();
  await appCard.waitFor({ state: "visible", timeout: 30000 });

  const popupPromise = browserContext.waitForEvent("page", { timeout: 5000 }).catch(() => null);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    appCard.click(),
  ]);

  const popup = await popupPromise;
  const activePage = popup ?? page;
  await activePage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await activePage.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return activePage;
}

async function isVisible(page: Page, selector: string, timeout = 1500): Promise<boolean> {
  return page.locator(selector).first().isVisible({ timeout }).catch(() => false);
}

async function selectGoogleAuthenticatorIfNeeded(page: Page, stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>): Promise<void> {
  const codeInputVisible = await isVisible(page, regalConfig.selectors.googleAuthenticatorCode);
  if (codeInputVisible) {
    await stageLog("info", "mfa", "Google Authenticator code page is already visible.", page);
    return;
  }

  const switchAuthenticatorVisible = await isVisible(page, regalConfig.selectors.switchAuthenticator);
  if (switchAuthenticatorVisible) {
    await stageLog("info", "mfa", "Switching to authenticator selection page.", page);
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      page.locator(regalConfig.selectors.switchAuthenticator).first().click(),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  }

  const googleOption = page.locator(regalConfig.selectors.googleAuthenticatorSelect).first();
  await googleOption.waitFor({ state: "visible", timeout: 30000 });
  await stageLog("info", "mfa", "Selecting Google Authenticator from available security methods.", page);
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    googleOption.click(),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
}

async function submitGoogleAuthenticatorTotp(page: Page): Promise<void> {
  const code = generateRegalTotpCode();
  const codeInput = page.locator(regalConfig.selectors.googleAuthenticatorCode).first();
  await codeInput.waitFor({ state: "visible", timeout: 30000 });
  await codeInput.fill("");
  await codeInput.fill(code);

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    page.locator(regalConfig.selectors.googleAuthenticatorSubmit).first().click(),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

export async function runRegalLoginJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parseRegalInput(formData);
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;
  let page: Page | undefined;
  let dashboardPage: Page | undefined;
  const logEntries: RegalLogEntry[] = [];

  const stageLog = async (level: RegalLogEntry["level"], stage: string, message: string, currentPage = page) => {
    const url = currentPage?.url();
    logEntries.push({
      timestamp: new Date().toISOString(),
      level,
      stage,
      message,
      url,
    });
    await context.log({ level, message: `[${stage}] ${message}${url ? ` Current URL: ${url}` : ""}` });
  };

  const emitLatestLog = async () => {
    const logContent = formatRegalLog(logEntries);
    const logPath = await saveRegalLatestLog(logContent);
    await context.log({ level: "info", message: `Regal latest log saved: ${logPath}` });
    await context.emit(downloadableTextFileEvent("regal-latest.log", logContent));
  };

  const signOutFromDashboard = async () => {
    const signOutPage = dashboardPage ?? page;
    if (!signOutPage) return false;
    const signOutLink = signOutPage.locator(regalConfig.selectors.signOut).first();
    if (!(await signOutLink.isVisible({ timeout: 1500 }).catch(() => false))) {
      await signOutPage.locator(regalConfig.selectors.userMenu).first().click({ timeout: 3000 }).catch(() => {});
    }
    if (!(await signOutLink.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    await stageLog("warn", "retry", "Signing out from Okta dashboard before retry.", signOutPage);
    await Promise.all([
      signOutPage.waitForLoadState("domcontentloaded").catch(() => {}),
      signOutLink.click(),
    ]);
    await signOutPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    page = signOutPage;
    return true;
  };

  const runFlow = async (attempt: number) => {
    await context.emit({ type: "progress", completed: 0, total: 6 });
    if (!browserContext) {
      const session = await launchRegalBrowser((message) => context.log({ level: "info", message }));
      browser = session.browser;
      browserContext = session.context;
      page = await browserContext.newPage();
    }
    if (!page || !browserContext) {
      throw new Error("Regal browser page was not initialized.");
    }

    await stageLog("info", "open-login", `Opening Regal login page. Attempt ${attempt}.`);
    await page.goto(input.credentials.loginUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await stageLog("info", "open-login", "Regal login page loaded.");
    await context.emit({ type: "progress", completed: 1, total: 6 });

    await stageLog("info", "username", "Filling Regal username and clicking Next.");
    await fillUsername(page, input.credentials.username);
    await context.emit({ type: "progress", completed: 2, total: 6 });

    const usernameStepError = await detectVisibleError(page);
    if (usernameStepError) {
      throw new Error(`Regal username step failed: ${usernameStepError}`);
    }
    await stageLog("info", "username", "Username accepted; password page reached.");

    await stageLog("info", "password", "Filling Regal password and clicking Verify.");
    await fillPassword(page, input.credentials.password);
    await context.emit({ type: "progress", completed: 3, total: 6 });

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    const passwordStepError = await detectVisibleError(page, 5000);
    if (passwordStepError) {
      throw new Error(`Regal password step failed: ${passwordStepError}`);
    }
    await stageLog("info", "password", "Password accepted; checking Okta dashboard.");

    await assertRegalDashboard(page);
    dashboardPage = page;
    await stageLog("info", "dashboard", "Confirmed Okta dashboard by Dashboard heading and Sign out link.");
    await context.emit({ type: "progress", completed: 4, total: 6 });

    await emitPageDiagnostics(context, page, "okta-dashboard-confirmed");
    await stageLog("info", "launch-rea", "Finding and clicking Regal Express Access (REA).");
    page = await launchRegalExpressAccess(page, browserContext);
    await stageLog("info", "launch-rea", "Regal Express Access click completed; checking reached page.", page);
    await context.emit({ type: "progress", completed: 5, total: 6 });

    await emitPageDiagnostics(context, page, "after-regal-express-access-before-mfa");
    await selectGoogleAuthenticatorIfNeeded(page, stageLog);
    await stageLog("info", "mfa", "Submitting current Google Authenticator TOTP.", page);
    await submitGoogleAuthenticatorTotp(page);
    const mfaStepError = await detectVisibleError(page, 5000);
    if (mfaStepError) {
      throw new Error(`Regal Google Authenticator step failed: ${mfaStepError}`);
    }
    await stageLog("info", "mfa", "Google Authenticator verification submitted; checking next page.", page);
    await emitPageDiagnostics(context, page, "after-google-authenticator-verify");
    await context.emit({ type: "progress", completed: 6, total: 6 });
    await context.emit({
      type: "warning",
      message: "Regal MFA was submitted. If this page shows a VPN/access error or expiry page, share the downloaded diagnostics for the next phase.",
    });
  };

  try {
    try {
      await runFlow(1);
    } catch (firstError) {
      const firstMessage = errorMessage(firstError);
      await stageLog("warn", "retry", `First Regal attempt failed: ${firstMessage}`);
      if (page) {
        await emitPageDiagnostics(context, page, "first-attempt-error", { error: true }).catch(() => {});
      }
      const signedOut = await signOutFromDashboard();
      if (!signedOut) {
        throw firstError;
      }
      await runFlow(2);
    }

    await emitLatestLog();
    await context.emit({ type: "done" });
  } catch (error) {
    const message = errorMessage(error);
    await stageLog("error", "failed", message);
    if (page) {
      await emitPageDiagnostics(context, page, "login-error", { error: true });
    }
    await emitLatestLog().catch((logError) => {
      void context.log({ level: "error", message: `Failed to create Regal latest log: ${errorMessage(logError)}` });
    });
    await context.emit({ type: "error", message });
    await context.emit({ type: "done" });
  } finally {
    await closeAutomationResources({
      browser,
      context: browserContext,
      page,
      log: (message) => context.log({ level: "info", message }),
    });
  }
}
