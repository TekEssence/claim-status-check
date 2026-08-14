import type { Browser, BrowserContext, Locator, Page, Response } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { ScraperContext } from "../../types";
import { launchRegalBrowser } from "./browser";
import { regalConfig } from "./config";
import regalGroups from "./groups.json";
import { parseRegalInput, type RegalClaimSearchInput } from "./input";
import { formatRegalLog, saveRegalLatestLog, type RegalLogEntry } from "./log-file";
import { createRegalOutputWorkbookBuffer } from "./workbook";

type DiagnosticEvent = {
  type: "debug_html" | "diagnostic_screenshot" | "error_screenshot";
  index: number;
  html?: string;
  image?: string;
  filename?: string;
};

type FileDownloadEvent = {
  type: "file_download" | "output_snapshot";
  filename: string;
  base64: string;
  mimeType: string;
  completed?: number;
  total?: number;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class RegalJobCancelledError extends Error {
  constructor() {
    super("Regal processing stopped by user.");
    this.name = "RegalJobCancelledError";
  }
}

async function emitPageDiagnostics(context: ScraperContext, page: Page, label: string, options: { error?: boolean } = {}): Promise<void> {
  if (!options.error) return;

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
      type: "error_screenshot",
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

async function dismissRegalPasswordExpiryWarningIfPresent(
  page: Page,
  stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>,
): Promise<boolean> {
  const warningTitle = page.locator(regalConfig.selectors.passwordExpiryTitle).first();
  const warningVisible = await warningTitle.waitFor({ state: "visible", timeout: 15000 }).then(() => true, () => false);
  if (!warningVisible) {
    return false;
  }

  const remindLater = page.locator(regalConfig.selectors.passwordExpiryRemindLater).first();
  await remindLater.waitFor({ state: "visible", timeout: 10000 });
  await stageLog("info", "password", "Regal password expiry warning appeared; clicking Remind me later.", page);
  await remindLater.click({ force: true });
  await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  if (await warningTitle.isVisible({ timeout: 1000 }).catch(() => false)) {
    await remindLater.click({ force: true }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  }
  return true;
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

function downloadableWorkbookEvent(filename: string, buffer: Buffer, options: { snapshot?: boolean; completed?: number; total?: number } = {}): FileDownloadEvent {
  return {
    type: options.snapshot ? "output_snapshot" : "file_download",
    filename,
    base64: buffer.toString("base64"),
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    completed: options.completed,
    total: options.total,
  };
}

async function assertRegalDashboard(
  page: Page,
  stageLog?: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>,
): Promise<void> {
  if (stageLog) {
    await dismissRegalPasswordExpiryWarningIfPresent(page, stageLog);
  }
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

async function openRegalEmailCodeEntryIfPresent(page: Page, stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>): Promise<boolean> {
  const sendEmailButton = page.locator(regalConfig.selectors.emailSendSubmit).first();
  const enterCodeInstead = page.locator(regalConfig.selectors.emailEnterCodeInstead).first();
  const codeInput = page.locator(regalConfig.selectors.googleAuthenticatorCode).first();
  const verifyButton = page.locator(regalConfig.selectors.googleAuthenticatorSubmit).first();

  const startedAt = Date.now();
  let emailRequested = false;
  let codeEntryOpened = false;

  while (Date.now() - startedAt < 30000) {
    if (await codeInput.isVisible({ timeout: 500 }).catch(() => false)) {
      await verifyButton.waitFor({ state: "visible", timeout: 30000 });
      return true;
    }

    if (!emailRequested && await sendEmailButton.isVisible({ timeout: 500 }).catch(() => false)) {
      emailRequested = true;
      await stageLog("info", "mfa", "Requesting Regal verification email.", page);
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        sendEmailButton.click(),
      ]);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      continue;
    }

    if (!codeEntryOpened && await enterCodeInstead.isVisible({ timeout: 500 }).catch(() => false)) {
      codeEntryOpened = true;
      await stageLog("info", "mfa", "Opening Regal email verification code entry field.", page);
      await enterCodeInstead.click();
      continue;
    }

    await page.waitForTimeout(500);
  }

  return false;
}

async function openRegalPhoneCodeEntryIfPresent(page: Page, stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>): Promise<boolean> {
  const sendCodeButton = page.locator(regalConfig.selectors.phoneSendSubmit).first();
  const codeInput = page.locator(regalConfig.selectors.googleAuthenticatorCode).first();
  const verifyButton = page.locator(regalConfig.selectors.googleAuthenticatorSubmit).first();
  const startedAt = Date.now();
  let codeRequested = false;

  while (Date.now() - startedAt < 30000) {
    if (await codeInput.isVisible({ timeout: 500 }).catch(() => false)) {
      await verifyButton.waitFor({ state: "visible", timeout: 30000 });
      return true;
    }

    if (!codeRequested && await sendCodeButton.isVisible({ timeout: 500 }).catch(() => false)) {
      codeRequested = true;
      await stageLog("info", "mfa", "Requesting Regal SMS verification code.", page);
      await Promise.all([
        page.waitForLoadState("domcontentloaded").catch(() => {}),
        sendCodeButton.click(),
      ]);
      await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      continue;
    }

    await page.waitForTimeout(500);
  }

  return false;
}

type RegalMfaMethodOption = {
  value: string;
  methodKey: string;
  rowIndex: number;
  label: string;
  description: string;
  disabled?: boolean;
  disabledReason?: string;
};

function normalizeMfaMethodValue(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
}

async function extractRegalMfaOptions(page: Page): Promise<RegalMfaMethodOption[]> {
  const rows = page.locator(".authenticator-verify-list .authenticator-row");
  const count = await rows.count();
  const options: RegalMfaMethodOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const buttonContainer = row.locator(".authenticator-button").first();
    const dataSe = normalizeText(await buttonContainer.getAttribute("data-se").catch(() => ""));
    const label = normalizeText(await row.locator(".authenticator-label").first().innerText().catch(() => ""));
    const description = normalizeText(await row.locator(".authenticator-description--text").first().innerText().catch(() => ""));
    const ariaLabel = normalizeText(await row.locator("a[data-se='button']").first().getAttribute("aria-label").catch(() => ""));
    const methodKey = dataSe || normalizeMfaMethodValue(`${label} ${description}`);
    const value = `${methodKey}__${index}`;
    if (!methodKey || !label) continue;

    const isPush = methodKey === "okta_verify-push" || /push notification/i.test(`${label} ${description} ${ariaLabel}`);
    options.push({
      value,
      methodKey,
      rowIndex: index,
      label,
      description,
      disabled: isPush,
      disabledReason: isPush ? "Push notification is not implemented for this scraper yet." : undefined,
    });
  }

  return options;
}

async function requestRegalMfaMethodFromUser(
  context: ScraperContext,
  stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>,
  page: Page,
  options: RegalMfaMethodOption[],
): Promise<string> {
  const enabledOptions = options.filter((option) => !option.disabled);
  if (enabledOptions.length === 0) {
    throw new Error("Regal displayed MFA methods, but none of the available methods are supported yet.");
  }

  await stageLog("info", "mfa", `Waiting for user to select Regal MFA method in frontend. Timeout: 1 minute. Options: ${options.map((option) => `${option.label}${option.description ? ` (${option.description})` : ""}`).join(", ")}.`, page);
  await context.emit({
    type: "input_request",
    inputName: "regal_mfa_method",
    label: "Select Regal verification method",
    message: "Choose the Regal verification method to use. Push notification is shown for visibility but is not implemented.",
    options,
    timeoutMs: 60000,
  });
  const selected = await waitForScrapeJobInput(context.jobId, "regal_mfa_method", 60000);
  const selectedOption = options.find((option) => option.value === selected);
  if (!selectedOption) {
    throw new Error(`Unsupported Regal MFA selection "${selected}".`);
  }
  if (selectedOption.disabled) {
    throw new Error(`${selectedOption.label} is not implemented for Regal automation yet.`);
  }

  return selectedOption.value;
}

function getRegalMfaMethodKey(methodValue: string): string {
  return methodValue.split("__", 1)[0] || methodValue;
}

async function clickSelectedRegalMfaMethod(page: Page, methodValue: string): Promise<void> {
  const methodKey = getRegalMfaMethodKey(methodValue);
  const rowIndex = Number(methodValue.match(/__(\d+)$/)?.[1]);
  const methodButton = Number.isFinite(rowIndex)
    ? page.locator(".authenticator-verify-list .authenticator-row").nth(rowIndex).locator("a[data-se='button']").first()
    : page.locator(`.authenticator-button[data-se='${methodKey}'] a[data-se='button']`).first();
  await methodButton.waitFor({ state: "visible", timeout: 30000 });
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    methodButton.click(),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
}

function otpLabelForRegalMfaMethod(methodValue: string): string {
  const methodKey = getRegalMfaMethodKey(methodValue);
  if (methodKey === "okta_email") return "Regal email OTP";
  if (methodKey === "phone_number") return "Regal SMS OTP";
  if (methodKey === "google_otp") return "Regal Google Authenticator OTP";
  if (methodKey === "okta_verify-totp") return "Regal Okta Verify OTP";
  return "Regal OTP";
}

async function prepareSelectedRegalMfaMethod(page: Page, methodValue: string, stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>): Promise<string> {
  const methodKey = getRegalMfaMethodKey(methodValue);
  await clickSelectedRegalMfaMethod(page, methodValue);

  if (methodKey === "okta_email") {
    if (!(await openRegalEmailCodeEntryIfPresent(page, stageLog))) {
      await stageLog("warn", "mfa", "Regal email MFA controls did not reach a visible verification code field within 30 seconds.", page);
      throw new Error("Regal email MFA was selected, but the verification code field did not appear.");
    }
  } else if (methodKey === "phone_number") {
    if (!(await openRegalPhoneCodeEntryIfPresent(page, stageLog))) {
      await stageLog("warn", "mfa", "Regal SMS MFA controls did not reach a visible verification code field within 30 seconds.", page);
      throw new Error("Regal SMS MFA was selected, but the verification code field did not appear.");
    }
  } else {
    await page.locator(regalConfig.selectors.googleAuthenticatorCode).first().waitFor({ state: "visible", timeout: 30000 });
  }

  return otpLabelForRegalMfaMethod(methodValue);
}

async function selectRegalOtpIfNeeded(page: Page, context: ScraperContext, stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>): Promise<string> {
  const codeInputVisible = await isVisible(page, regalConfig.selectors.googleAuthenticatorCode);
  if (codeInputVisible) {
    await stageLog("info", "mfa", "OTP code page is already visible.", page);
    return "Regal OTP";
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

  const authenticatorListVisible = await page
    .locator(".authenticator-verify-list .authenticator-row")
    .first()
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => true, () => false);

  if (authenticatorListVisible) {
    await stageLog("info", "mfa", "Regal authenticator selection page reached; reading available methods for frontend selection.", page);
    const options = await extractRegalMfaOptions(page);
    const selectedMethod = await requestRegalMfaMethodFromUser(context, stageLog, page, options);
    await stageLog("info", "mfa", `User selected Regal MFA method: ${selectedMethod}.`, page);
    return prepareSelectedRegalMfaMethod(page, selectedMethod, stageLog);
  }

  const emailSendVisible = await isVisible(page, regalConfig.selectors.emailSendSubmit, 1000);
  const emailEnterCodeVisible = await isVisible(page, regalConfig.selectors.emailEnterCodeInstead, 1000);
  if (emailSendVisible || emailEnterCodeVisible) {
    if (await openRegalEmailCodeEntryIfPresent(page, stageLog)) {
      return "Regal email OTP";
    }
    throw new Error("Regal email MFA page was visible, but the verification code field did not appear.");
  }

  const phoneSendVisible = await isVisible(page, regalConfig.selectors.phoneSendSubmit, 1000);
  if (phoneSendVisible) {
    if (await openRegalPhoneCodeEntryIfPresent(page, stageLog)) {
      return "Regal SMS OTP";
    }
    throw new Error("Regal SMS MFA page was visible, but the verification code field did not appear.");
  }

  await page.locator(".authenticator-verify-list .authenticator-row").first().waitFor({ state: "visible", timeout: 30000 });
  await stageLog("info", "mfa", "Regal authenticator selection page reached after wait; reading available methods for frontend selection.", page);
  const options = await extractRegalMfaOptions(page);
  const selectedMethod = await requestRegalMfaMethodFromUser(context, stageLog, page, options);
  await stageLog("info", "mfa", `User selected Regal MFA method: ${selectedMethod}.`, page);
  return prepareSelectedRegalMfaMethod(page, selectedMethod, stageLog);
}

async function requestRegalOtpFromUser(context: ScraperContext, stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>, page: Page, otpLabel: string): Promise<string> {
  await stageLog("info", "mfa", `Waiting for user to enter ${otpLabel} in frontend. Timeout: 2 minutes.`, page);
  await context.emit({
    type: "input_request",
    inputName: "regal_otp",
    label: otpLabel,
    message: `Enter the ${otpLabel} within 2 minutes.`,
    timeoutMs: 120000,
  });
  await stageLog("info", "mfa", "Regal OTP input request sent to frontend.", page);
  return waitForScrapeJobInput(context.jobId, "regal_otp", 120000);
}

async function submitRegalOtp(page: Page, code: string): Promise<void> {
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

async function isPastRegalMfa(page: Page): Promise<boolean> {
  return Promise.race([
    findRegalLocator(page, regalConfig.selectors.siteSelect, { state: "visible", timeout: 1500 }).then(() => true, () => false),
    findRegalLocator(page, regalConfig.selectors.viewClaimsLink, { state: "attached", timeout: 1500 }).then(() => true, () => false),
    page.locator(regalConfig.selectors.mainIframe).first().waitFor({ state: "attached", timeout: 1500 }).then(() => true, () => false),
  ]);
}

type RegalClaimSearchRow = {
  index: number;
  href: string;
  absoluteHref: string;
  memberName: string;
  memberHmoId: string;
  providerName: string;
  claimNumber: string;
  firstDateOfService: string;
  diagnosis: string;
  billed: string;
  payAmount: string;
  status: string;
};

type RegalClaimSummary = {
  provider: string;
  specialty: string;
  claimNumber: string;
  claimDate: string;
  memberIdName: string;
  carrier: string;
};

type RegalLineDetailRow = Record<string, string>;

const regalGroupMap = regalGroups as Record<string, string>;

function normalizeText(value: unknown): string {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeColumnName(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/\//g, " ")
    .replace(/#/g, "number")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function splitClaimNumberAndDate(value: string): { claimNumber: string; claimDate: string } {
  const [claimNumber = "", claimDate = ""] = normalizeText(value).split(/\s+-\s+/, 2);
  return { claimNumber, claimDate };
}

function normalizeSearchText(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function normalizeRegalDate(value: string): string {
  const match = normalizeText(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return normalizeText(value);
  const [, month, day, year] = match;
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${Number(month)}/${Number(day)}/${fullYear}`;
}

function formatRegalDateForSearch(value: string): string {
  const match = normalizeText(value).match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return normalizeText(value);

  const [, month, day, year] = match;
  const fullYear = year.length === 2 ? `20${year}` : year;
  return `${String(Number(month)).padStart(2, "0")}/${String(Number(day)).padStart(2, "0")}/${fullYear}`;
}

function regalRowMatchesInput(row: RegalClaimSearchRow, input: { memberName: string; dos: string }): boolean {
  const inputMember = normalizeSearchText(input.memberName);
  const rowMember = normalizeSearchText(row.memberName);
  const inputLastNamePrefix = normalizeSearchText(input.memberName.split(",")[0] || input.memberName).slice(0, 3);
  const memberMatches = Boolean(inputLastNamePrefix && rowMember.includes(inputLastNamePrefix)) || Boolean(rowMember && inputMember.includes(rowMember.slice(0, 3)));
  const dosMatches = normalizeRegalDate(row.firstDateOfService) === normalizeRegalDate(input.dos);
  return memberMatches && dosMatches;
}

function normalizeRegalSiteText(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]/g, "");
}

async function readRegalTableRows(table: Locator): Promise<string[][]> {
  const rowLocator = table.locator("tr");
  const rowCount = await rowLocator.count();
  const rows: string[][] = [];
  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cellTexts = await rowLocator.nth(rowIndex).locator("td").allTextContents();
    rows.push(cellTexts.map((cell) => normalizeText(cell)));
  }
  return rows;
}

async function getVisibleRegalSiteText(page: Page): Promise<string> {
  const frameTexts: string[] = [];
  for (const frame of page.frames()) {
    const selectedSite = await frame
      .locator(regalConfig.selectors.siteSelect)
      .first()
      .locator("option:checked")
      .textContent({ timeout: 1000 })
      .catch(() => "");
    const hiddenSite = await frame
      .locator("span[id$='_header_lblSite'], span[id*='lblSite']")
      .first()
      .textContent({ timeout: 1000 })
      .catch(() => "");
    const bodyText = await frame.locator("body").innerText({ timeout: 1000 }).catch(() => "");
    const siteLine = bodyText
      .split(/\r?\n/)
      .map((line) => normalizeText(line))
      .find((line) => /^site:\s*\S/i.test(line) || /\bsite:\s*\S/i.test(line));
    frameTexts.push([selectedSite, hiddenSite, siteLine].map(normalizeText).filter(Boolean).join("\n"));
  }
  const locatorText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  const siteLine = locatorText.split(/\r?\n/).map((line) => normalizeText(line)).find((line) => /^site:\s*\S/i.test(line) || /\bsite:\s*\S/i.test(line)) || "";
  const combined = `${siteLine}\n${frameTexts.join("\n")}`;
  const siteMatch = combined.match(/Site:\s*([^\n\r]+)/i);
  return normalizeText(siteMatch?.[1] || combined);
}

async function waitForRegalSiteHeader(page: Page, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await findRegalLocator(page, regalConfig.selectors.siteSelect, { state: "attached", timeout: 1000 }).then(() => true, () => false)) {
      return;
    }
    const visibleSiteText = await getVisibleRegalSiteText(page);
    if (visibleSiteText) {
      return;
    }
    await page.waitForTimeout(500);
  }
  throw new Error("Regal site header/dropdown did not load within 30 seconds.");
}

function resolveRegalGroupName(group: string): string {
  const groupCode = normalizeText(group).replace(/\s+/g, "").toUpperCase();
  const groupName = regalGroupMap[groupCode];
  if (!groupName) {
    throw new Error(`Unknown Regal group "${group}". Known groups: ${Object.keys(regalGroupMap).join(", ")}.`);
  }
  return groupName;
}

function groupRegalClaimRows(rows: RegalClaimSearchInput[]): Array<{ group: string; groupName: string; rows: RegalClaimSearchInput[] }> {
  const groups = new Map<string, { group: string; groupName: string; rows: RegalClaimSearchInput[] }>();
  for (const row of rows) {
    const group = normalizeText(row.group).replace(/\s+/g, "").toUpperCase();
    const groupName = resolveRegalGroupName(group);
    const existing = groups.get(group);
    if (existing) {
      existing.rows.push(row);
    } else {
      groups.set(group, { group, groupName, rows: [row] });
    }
  }
  return Array.from(groups.values());
}

async function selectRegalGroupSite(page: Page, group: string, stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>): Promise<void> {
  const groupName = resolveRegalGroupName(group);
  await waitForRegalSiteHeader(page, 30000);
  const siteSelect =
    await findRegalLocator(page, regalConfig.selectors.siteSelect, { state: "visible", timeout: 5000 }).catch(() => null) ??
    await findRegalLocator(page, regalConfig.selectors.siteSelect, { state: "attached", timeout: 5000 }).catch(() => null);
  if (!siteSelect) {
    const visibleSiteText = await getVisibleRegalSiteText(page);
    if (normalizeRegalSiteText(visibleSiteText).includes(normalizeRegalSiteText(groupName))) {
      await stageLog("info", "group", `Regal group ${group} confirmed from fixed site text: ${groupName}.`, page);
      return;
    }

    if (normalizeText(group).replace(/\s+/g, "").toUpperCase() === "USA") {
      await stageLog("warn", "group", `Regal site dropdown was not available and site text could not be confirmed, but this login appears to be fixed-site. Continuing with ${group}: ${groupName}.`, page);
      return;
    }

    throw new Error(`Regal site dropdown was not available, and current site did not match group ${group}. Expected "${groupName}". Current page showed "${visibleSiteText.slice(0, 120) || "(unknown)"}".`);
  }

  const selectedText = await siteSelect.locator("option:checked").innerText().catch(() => "");

  if (normalizeRegalSiteText(selectedText).includes(normalizeRegalSiteText(groupName))) {
    await stageLog("info", "group", `Regal group ${group} already selected: ${selectedText}.`, page);
    return;
  }

  const optionLocator = siteSelect.locator("option");
  const optionCount = await optionLocator.count();
  let value = "";
  for (let index = 0; index < optionCount; index += 1) {
    const option = optionLocator.nth(index);
    const optionText = await option.innerText().catch(() => "");
    if (normalizeRegalSiteText(optionText).includes(normalizeRegalSiteText(groupName))) {
      value = await option.getAttribute("value").then((optionValue) => optionValue || "");
      break;
    }
  }

  if (!value) {
    throw new Error(`Regal group ${group} could not be found in the site dropdown. Expected option containing "${groupName}".`);
  }

  await stageLog("info", "group", `Selecting Regal group ${group}: ${groupName}.`, page);
  await siteSelect.selectOption(value);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  const updatedText = await siteSelect.locator("option:checked").innerText().catch(() => "");
  if (!normalizeRegalSiteText(updatedText).includes(normalizeRegalSiteText(groupName))) {
    throw new Error(`Regal group ${group} was not selected. Current site is "${updatedText || "(unknown)"}".`);
  }
}

async function returnToRegalHomeForGroupSelection(page: Page, stageLog: (level: RegalLogEntry["level"], stage: string, message: string, currentPage?: Page) => Promise<void>): Promise<void> {
  const homeUrl = new URL("home.aspx", regalContentUrl(page)).toString();
  await stageLog("info", "group", `Returning to Regal home page before changing group: ${homeUrl}.`, page);
  await page.goto(homeUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await Promise.race([
    findRegalLocator(page, regalConfig.selectors.siteSelect, { state: "visible", timeout: 30000 }),
    findRegalLocator(page, regalConfig.selectors.viewClaimsLink, { state: "attached", timeout: 30000 }),
  ]);
}

function createRegalNoClaimsOutputRow(claimInput: { rowNumber: number; accountNumber?: string; group: string; memberName: string; dos: string }): Record<string, unknown> {
  return {
    "Account Number": claimInput.accountNumber ?? "",
    input_row_number: claimInput.rowNumber,
    input_group: claimInput.group,
    input_member_name: claimInput.memberName,
    input_dos: claimInput.dos,
    search_result_index: "",
    search_member_name: "",
    search_member_hmo_id: "",
    search_provider_name: "",
    search_claim_number: "",
    search_first_date_of_service: "",
    search_diagnosis: "",
    search_billed: "",
    search_pay_amount: "",
    search_status: "No claims on file.",
    final_status: "No claims on file.",
  };
}

function frameLocator(page: Page, selector: string): Locator {
  return page.frameLocator(regalConfig.selectors.mainIframe).locator(selector).first();
}

function frameLocators(page: Page, selector: string): Locator {
  return page.frameLocator(regalConfig.selectors.mainIframe).locator(selector);
}

function regalContentFrame(page: Page) {
  return page.frame({ name: "ifrm_Main" });
}

function regalContentUrl(page: Page): string {
  return regalContentFrame(page)?.url() || page.url();
}

async function findRegalLocator(page: Page, selector: string, options: { state?: "attached" | "visible"; timeout?: number } = {}): Promise<Locator> {
  const state = options.state || "visible";
  const timeout = options.timeout || 30000;
  const iframeExists = await page.locator(regalConfig.selectors.mainIframe).first().waitFor({ state: "attached", timeout: 1000 }).then(
    () => true,
    () => false,
  );

  if (iframeExists) {
    const iframeLocator = frameLocator(page, selector);
    if (await iframeLocator.waitFor({ state, timeout: 1000 }).then(() => true, () => false)) {
      return iframeLocator;
    }
  }

  const topLocator = page.locator(selector).first();
  await topLocator.waitFor({ state, timeout });
  return topLocator;
}

async function findRegalLocators(page: Page, selector: string, options: { state?: "attached" | "visible"; timeout?: number } = {}): Promise<Locator> {
  const state = options.state || "visible";
  const timeout = options.timeout || 30000;
  const iframeExists = await page.locator(regalConfig.selectors.mainIframe).first().waitFor({ state: "attached", timeout: 1000 }).then(
    () => true,
    () => false,
  );

  if (iframeExists) {
    const iframeLocators = frameLocators(page, selector);
    if (await iframeLocators.first().waitFor({ state, timeout: 1000 }).then(() => true, () => false)) {
      return iframeLocators;
    }
  }

  const topLocators = page.locator(selector);
  await topLocators.first().waitFor({ state, timeout });
  return topLocators;
}

async function getRegalResultsTableText(page: Page): Promise<string> {
  const table = await findRegalLocator(page, regalConfig.selectors.claimResultsTable, { state: "visible", timeout: 1000 }).catch(() => null);
  return table ? normalizeText(await table.textContent().catch(() => "")) : "";
}

async function hasRegalNoClaimsMessage(page: Page, timeout = 1000): Promise<boolean> {
  return findRegalLocator(page, regalConfig.selectors.noClaimsMessage, { state: "visible", timeout }).then(
    () => true,
    () => false,
  );
}

async function waitForRegalResultsTableOrNoClaims(page: Page): Promise<"table" | "no-claims"> {
  const iframe = page.locator(regalConfig.selectors.mainIframe).first();
  const iframeAppeared = await iframe.waitFor({ state: "attached", timeout: 15000 }).then(() => true, () => false);

  const tableLocator = iframeAppeared
    ? page.frameLocator(regalConfig.selectors.mainIframe).locator(regalConfig.selectors.claimResultsTable).first()
    : page.locator(regalConfig.selectors.claimResultsTable).first();
  const noClaimsLocator = iframeAppeared
    ? page.frameLocator(regalConfig.selectors.mainIframe).locator(regalConfig.selectors.noClaimsMessage).first()
    : page.locator(regalConfig.selectors.noClaimsMessage).first();

  const result = await Promise.race([
    tableLocator.waitFor({ state: "visible", timeout: 30000 }).then(() => "table" as const),
    noClaimsLocator.waitFor({ state: "visible", timeout: 30000 }).then(() => "no-claims" as const),
  ]);

  return result;
}

async function waitForRegalResultsTextChange(page: Page, previousResultsText: string): Promise<boolean> {
  if (!previousResultsText) return true;

  const startedAt = Date.now();
  while (Date.now() - startedAt < 30000) {
    const currentText = await getRegalResultsTableText(page);
    if (currentText && currentText !== previousResultsText) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

function isRegalClaimSearchDocumentResponse(response: Response): boolean {
  const url = response.url().toLowerCase();
  return url.includes("selclaimmember.asp") && response.request().resourceType() === "document" && response.status() === 200;
}

async function waitForRegalSearchResultsRefresh(page: Page, responsePromise: Promise<Response | null>, previousResultsText: string): Promise<void> {
  const response = await responsePromise;
  if (!response) {
    throw new Error("Regal search did not make a completed selclaimmember.asp document request.");
  }

  const resultType = await waitForRegalResultsTableOrNoClaims(page);
  if (resultType === "no-claims") {
    return;
  }

  if (!(await waitForRegalResultsTextChange(page, previousResultsText))) {
    throw new Error("Regal search results did not refresh after clicking Search; refusing to process stale rows.");
  }
}

async function navigateToViewClaims(page: Page): Promise<void> {
  const waitForClaimsSearchForm = (timeout: number) =>
    findRegalLocator(page, regalConfig.selectors.claimMemberInput, { state: "visible", timeout }).then(
      () => true,
      () => false,
    );

  const viewClaimsLink = page.locator(regalConfig.selectors.viewClaimsLink).first();
  await viewClaimsLink.waitFor({ state: "attached", timeout: 30000 });

  if (await viewClaimsLink.isVisible({ timeout: 1000 }).catch(() => false)) {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      viewClaimsLink.click(),
    ]);
  } else {
    await page.goto(new URL("selclaimmember.asp", page.url()).toString(), { waitUntil: "domcontentloaded" });
  }

  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  if (await waitForClaimsSearchForm(5000)) return;

  await page.goto(new URL("selclaimmember.asp", page.url()).toString(), { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await findRegalLocator(page, regalConfig.selectors.claimMemberInput, { state: "visible", timeout: 30000 });
}

async function searchRegalClaims(page: Page, search: { memberName: string; dos: string }): Promise<void> {
  const searchDos = formatRegalDateForSearch(search.dos);
  const previousResultsText = await getRegalResultsTableText(page);
  const memberInput = await findRegalLocator(page, regalConfig.selectors.claimMemberInput, { state: "visible", timeout: 30000 });
  const dosInput = await findRegalLocator(page, regalConfig.selectors.claimDosInput, { state: "visible", timeout: 30000 });
  const timeFrameSelect = await findRegalLocator(page, regalConfig.selectors.claimTimeFrameSelect, { state: "visible", timeout: 30000 });
  const searchButton = await findRegalLocator(page, regalConfig.selectors.claimSearchSubmit, { state: "visible", timeout: 30000 });

  await memberInput.fill("");
  await memberInput.fill(search.memberName);
  await dosInput.fill("");
  await dosInput.fill(searchDos);
  await timeFrameSelect.selectOption("-1");

  const actualDos = await dosInput.inputValue().catch(() => "");
  if (actualDos !== searchDos) {
    throw new Error(`Regal DOS field did not contain normalized DOS ${searchDos}; actual value was ${actualDos || "(blank)"}.`);
  }

  const responsePromise = page.waitForResponse(isRegalClaimSearchDocumentResponse, { timeout: 30000 }).catch(() => null);
  await searchButton.click();
  await waitForRegalSearchResultsRefresh(page, responsePromise, previousResultsText);
}

async function returnToRegalClaimSearch(page: Page, claimsSearchUrl: string): Promise<void> {
  await page.goto(claimsSearchUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  if (await findRegalLocator(page, regalConfig.selectors.claimMemberInput, { state: "visible", timeout: 5000 }).then(() => true, () => false)) {
    return;
  }

  await navigateToViewClaims(page);
}

async function extractRegalClaimRows(page: Page): Promise<RegalClaimSearchRow[]> {
  if (await hasRegalNoClaimsMessage(page)) {
    return [];
  }

  const table = await findRegalLocator(page, regalConfig.selectors.claimResultsTable, { state: "visible", timeout: 30000 });
  await table.waitFor({ state: "visible", timeout: 30000 });

  const rowLocator = table.locator("tbody tr");
  const rowCount = await rowLocator.count();
  const rows: RegalClaimSearchRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const row = rowLocator.nth(index);
    const cells = (await row.locator("td").allTextContents()).map((cell) => normalizeText(cell));
    const href = await row.locator("td:first-child a").first().getAttribute("href").catch(() => "") || "";
    const absoluteHref = href ? new URL(href, regalContentUrl(page)).toString() : "";
    const parsedRow = {
      index,
      href,
      absoluteHref,
      memberName: cells[0] || "",
      memberHmoId: cells[1] || "",
      providerName: cells[2] || "",
      claimNumber: cells[3] || "",
      firstDateOfService: cells[4] || "",
      diagnosis: cells[5] || "",
      billed: cells[6] || "",
      payAmount: cells[7] || "",
      status: cells[8] || "",
    };
    if (parsedRow.claimNumber || parsedRow.memberName) {
      rows.push(parsedRow);
    }
  }
  return rows;
}

async function openRegalClaimResult(page: Page, claimRow: RegalClaimSearchRow): Promise<void> {
  const detailUrl = claimRow.absoluteHref || (claimRow.href ? new URL(claimRow.href, regalContentUrl(page)).toString() : "");
  if (detailUrl) {
    const frame = regalContentFrame(page);
    if (frame) {
      await frame.goto(detailUrl, { waitUntil: "domcontentloaded" });
    } else {
      await page.goto(detailUrl, { waitUntil: "domcontentloaded" });
    }
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await Promise.race([
      findRegalLocator(page, regalConfig.selectors.lineDetailSubmit, { state: "attached", timeout: 30000 }),
      findRegalLocators(page, "table", { state: "attached", timeout: 30000 }),
    ]);
    return;
  }

  const index = claimRow.index;
  const topClaimLink = page.locator(`${regalConfig.selectors.claimResultsTable} tbody tr td:first-child a`).nth(index);
  const claimLink = await topClaimLink.waitFor({ state: "visible", timeout: 1000 }).then(
    () => topClaimLink,
    () => page.frameLocator(regalConfig.selectors.mainIframe).locator(`${regalConfig.selectors.claimResultsTable} tbody tr td:first-child a`).nth(index),
  );
  await claimLink.waitFor({ state: "visible", timeout: 30000 });
  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    claimLink.click(),
  ]);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

async function extractRegalClaimSummary(page: Page): Promise<RegalClaimSummary> {
  const tablesLocator = await findRegalLocators(page, "table", { state: "attached", timeout: 30000 });
  const details: Record<string, string> = {};
  const tableCount = await tablesLocator.count();
  for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
    const rows = await readRegalTableRows(tablesLocator.nth(tableIndex));
    for (const cells of rows) {
      if (cells.length < 2) continue;
      const label = normalizeText(cells[0]).toLowerCase();
      const value = normalizeText(cells[1]);
      if (label && value && !details[label]) {
        details[label] = value;
      }
    }
  }
  const splitClaim = splitClaimNumberAndDate(details["claim #"] || "");

  return {
    provider: details.provider || "",
    specialty: details.specialty || "",
    claimNumber: splitClaim.claimNumber,
    claimDate: splitClaim.claimDate,
    memberIdName: details["member id/name"] || "",
    carrier: details.carrier || "",
  };
}

async function showRegalLineDetail(page: Page): Promise<void> {
  if (await findRegalLocator(page, regalConfig.selectors.lineDetailHideSubmit, { state: "visible", timeout: 3000 }).then(() => true, () => false)) {
    await findRegalLocator(page, regalConfig.selectors.lineDetailTable, { state: "visible", timeout: 30000 });
    await findRegalLocator(page, regalConfig.selectors.lineDetailAdjustmentTable, { state: "visible", timeout: 5000 }).catch(() => {});
    return;
  }

  const showButton = await findRegalLocator(page, regalConfig.selectors.lineDetailShowSubmit, { state: "attached", timeout: 30000 });
  const showValue = normalizeText(await showButton.inputValue().catch(async () => await showButton.getAttribute("value").catch(() => "") || ""));
  if (!/show line detail/i.test(showValue)) {
    await findRegalLocator(page, regalConfig.selectors.lineDetailHideSubmit, { state: "visible", timeout: 30000 });
  } else {
    await Promise.all([
      page.waitForLoadState("domcontentloaded").catch(() => {}),
      showButton.click({ force: true }),
    ]);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await findRegalLocator(page, regalConfig.selectors.lineDetailHideSubmit, { state: "visible", timeout: 30000 });
  }

  await findRegalLocator(page, regalConfig.selectors.lineDetailTable, { state: "visible", timeout: 30000 });
  await findRegalLocator(page, regalConfig.selectors.lineDetailAdjustmentTable, { state: "visible", timeout: 5000 }).catch(() => {});
}

async function extractRegalLineDetails(page: Page): Promise<RegalLineDetailRow[]> {
  const tablesLocator = await findRegalLocators(page, "table", { state: "attached", timeout: 30000 });
  const normalizeColumn = (value: string) =>
    normalizeText(value)
      .toLowerCase()
      .replace(/\//g, " ")
      .replace(/#/g, "number")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");

  const parseLineRows = (rows: string[][]) => {
    const headerIndex = rows.findIndex((row) => row.some((cell) => normalizeColumn(cell) === "seqnm"));
    if (headerIndex < 0) return [];

    const headers = rows[headerIndex].map(normalizeColumn);
    return rows.slice(headerIndex + 1)
      .filter((row) => row.some(Boolean))
      .map((row) => {
        const values: Record<string, string> = {};
        headers.forEach((header, index) => {
          if (header) values[header] = row[index] || "";
        });
        return values;
      })
      .filter((row) => (row.seqnm || row.cpt || row.dos) && normalizeText(row.seqnm).toLowerCase() !== "totals");
  };

  const parseAdjustmentRows = (rows: string[][]) => {
    const adjustmentHeaderIndex = rows.findIndex((row) => row.some((cell) => normalizeColumn(cell) === "deductible"));
    const finalHeaderIndex = rows.findIndex((row) => row.some((cell) => normalizeColumn(cell) === "final_adj"));

    const firstAdjustment = adjustmentHeaderIndex >= 0 ? rows[adjustmentHeaderIndex + 1] || [] : [];
    const firstAdjustmentHeaders = adjustmentHeaderIndex >= 0 ? rows[adjustmentHeaderIndex].map(normalizeColumn) : [];
    const finalAdjustment = finalHeaderIndex >= 0 ? rows[finalHeaderIndex + 1] || [] : [];
    const finalAdjustmentHeaders = finalHeaderIndex >= 0 ? rows[finalHeaderIndex].map(normalizeColumn) : [];
    const values: Record<string, string> = {};
    const expectedAdjustmentColumns = [
      "deductible",
      "copay",
      "coinsurance",
      "adjustment",
      "adjustment_reason",
      "final_adj",
      "final_adj_reason",
    ];
    expectedAdjustmentColumns.forEach((column) => {
      values[column] = "";
    });

    firstAdjustmentHeaders.forEach((header, index) => {
      if (!header) return;
      if (!Object.prototype.hasOwnProperty.call(values, header)) return;
      values[header] = firstAdjustment[index] || "";
    });
    finalAdjustmentHeaders.forEach((header, index) => {
      if (!header) return;
      if (!Object.prototype.hasOwnProperty.call(values, header)) return;
      values[header] = finalAdjustment[index] || "";
    });

    return values;
  };

  const tableRows: string[][][] = [];
  const tableTexts: string[] = [];
  const tableCount = await tablesLocator.count();
  for (let index = 0; index < tableCount; index += 1) {
    const table = tablesLocator.nth(index);
    tableRows.push(await readRegalTableRows(table));
    tableTexts.push(normalizeText(await table.innerText().catch(() => "")));
  }

  const isLineTable = (index: number) => tableTexts[index]?.includes("SEQNM") && tableTexts[index]?.includes("CPT");
  const isAdjustmentTable = (index: number) => tableTexts[index]?.includes("Deductible") && tableTexts[index]?.includes("Adjustment Reason");

  const output: Record<string, string>[] = [];
  for (let index = 0; index < tableRows.length; index += 1) {
    if (!isLineTable(index)) continue;

    const lineRows = parseLineRows(tableRows[index]);
    if (lineRows.length === 0) continue;

    let adjustmentValues: Record<string, string> = {};
    for (let nextIndex = index + 1; nextIndex < tableRows.length; nextIndex += 1) {
      if (isLineTable(nextIndex)) break;
      if (isAdjustmentTable(nextIndex)) {
        adjustmentValues = parseAdjustmentRows(tableRows[nextIndex]);
        break;
      }
    }

    output.push(...lineRows.map((line) => ({ ...line, ...adjustmentValues })));
  }

  return output;
}

async function extractRegalClaimDetailRows(page: Page): Promise<{ summary: RegalClaimSummary; lineDetails: RegalLineDetailRow[] }> {
  const summary = await extractRegalClaimSummary(page);
  await showRegalLineDetail(page);
  const lineDetails = await extractRegalLineDetails(page);
  return { summary, lineDetails };
}

export async function runRegalLoginJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parseRegalInput(formData);
  let browser: Browser | undefined;
  let browserContext: BrowserContext | undefined;
  let page: Page | undefined;
  let dashboardPage: Page | undefined;
  const logEntries: RegalLogEntry[] = [];
  const outputRows: Record<string, unknown>[] = [];
  let outputWorkbookEmitted = false;

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

  const emitOutputWorkbook = async () => {
    if (outputWorkbookEmitted || outputRows.length === 0) return;
    await context.emit(downloadableWorkbookEvent("regal_output.xlsx", createRegalOutputWorkbookBuffer(outputRows, { auditLog: logEntries })));
    outputWorkbookEmitted = true;
  };

  const emitOutputSnapshot = async (completed: number, total: number) => {
    if (outputRows.length === 0) return;
    await context.emit(downloadableWorkbookEvent(
      "regal_output_snapshot.xlsx",
      createRegalOutputWorkbookBuffer(outputRows, { auditLog: logEntries }),
      { snapshot: true, completed, total },
    ));
  };

  const throwIfCancelled = async () => {
    if (context.isCancelled?.()) {
      await stageLog("warn", "cancelled", "Regal processing stopped because the active scrape job was cancelled.");
      throw new RegalJobCancelledError();
    }
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
    const progressTotal = input.totalRows;
    let completedRows = input.startIndex;
    await context.emit({ type: "progress", completed: completedRows, total: progressTotal });
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

    await stageLog("info", "username", "Filling Regal username and clicking Next.");
    await fillUsername(page, input.credentials.username);

    const usernameStepError = await detectVisibleError(page);
    if (usernameStepError) {
      throw new Error(`Regal username step failed: ${usernameStepError}`);
    }
    await stageLog("info", "username", "Username accepted; password page reached.");

    await stageLog("info", "password", "Filling Regal password and clicking Verify.");
    await fillPassword(page, input.credentials.password);

    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await dismissRegalPasswordExpiryWarningIfPresent(page, stageLog);
    const passwordStepError = await detectVisibleError(page, 5000);
    if (passwordStepError) {
      throw new Error(`Regal password step failed: ${passwordStepError}`);
    }
    await stageLog("info", "password", "Password accepted; checking Okta dashboard.");

    await assertRegalDashboard(page, stageLog);
    dashboardPage = page;
    await stageLog("info", "dashboard", "Confirmed Okta dashboard by Dashboard heading and Sign out link.");

    await stageLog("info", "launch-rea", "Finding and clicking Regal Express Access (REA).");
    page = await launchRegalExpressAccess(page, browserContext);
    await stageLog("info", "launch-rea", "Regal Express Access click completed; checking reached page.", page);

    const otpLabel = await selectRegalOtpIfNeeded(page, context, stageLog);
    if (!(await isPastRegalMfa(page))) {
      const regalOtp = await requestRegalOtpFromUser(context, stageLog, page, otpLabel);
      if (await isPastRegalMfa(page)) {
        await stageLog("info", "mfa", "Regal MFA already completed in the automation browser; continuing.", page);
      } else {
        await stageLog("info", "mfa", "Submitting Regal OTP provided from frontend.", page);
        await submitRegalOtp(page, regalOtp);
      }
    } else {
      await stageLog("info", "mfa", "Regal MFA already completed; continuing.", page);
    }
    const mfaStepError = await detectVisibleError(page, 5000);
    if (mfaStepError) {
      throw new Error(`Regal OTP step failed: ${mfaStepError}`);
    }
    await stageLog("info", "mfa", "Regal OTP submitted; checking next page.", page);

    let totalSearchResults = 0;
    const groupedClaimRows = groupRegalClaimRows(input.claimRows);

    for (const [groupBatchIndex, groupBatch] of groupedClaimRows.entries()) {
      await throwIfCancelled();
      if (groupBatchIndex > 0) {
        await returnToRegalHomeForGroupSelection(page, stageLog);
      }
      await selectRegalGroupSite(page, groupBatch.group, stageLog);
      await stageLog("info", "view-claims", `Opening Regal View Claims page for group ${groupBatch.group}.`, page);
      await navigateToViewClaims(page);
      await stageLog("info", "view-claims", `Regal View Claims search page reached for group ${groupBatch.group}. Iframe URL: ${regalContentUrl(page)}.`, page);
      const claimsSearchUrl = page.url();

      for (const claimInput of groupBatch.rows) {
        await throwIfCancelled();
        await stageLog(
          "info",
          "claim-search",
          `Searching Regal input row ${claimInput.rowNumber} (${claimInput.group}): member "${claimInput.memberName}" and DOS ${claimInput.dos}.`,
          page,
        );
        await searchRegalClaims(page, claimInput);
        await throwIfCancelled();
        const rawClaimRows = await extractRegalClaimRows(page);
        const claimRows = rawClaimRows.filter((row) => regalRowMatchesInput(row, claimInput));
        if (rawClaimRows.length === 0 && await hasRegalNoClaimsMessage(page)) {
          outputRows.push(createRegalNoClaimsOutputRow(claimInput));
          await stageLog("info", "claim-search", `Regal input row ${claimInput.rowNumber}: No claims on file.`, page);
        }
        totalSearchResults += claimRows.length;
      await stageLog(
        "info",
        "claim-search",
        `Regal input row ${claimInput.rowNumber} returned ${rawClaimRows.length} raw row(s), ${claimRows.length} matched this input row.`,
        page,
      );
      for (const row of claimRows) {
        await stageLog(
          "info",
          "claim-search",
          `Input row ${claimInput.rowNumber}, result ${row.index + 1}: ${row.memberName} | ${row.memberHmoId} | ${row.claimNumber} | ${row.firstDateOfService} | ${row.status} | ${row.absoluteHref || row.href}`,
          page,
        );
      }

      for (const claimRow of claimRows) {
        await throwIfCancelled();
        await stageLog("info", "claim-detail", `Opening Regal claim result ${claimRow.index + 1} for input row ${claimInput.rowNumber}.`, page);
        await openRegalClaimResult(page, claimRow);
        await throwIfCancelled();
        await stageLog("info", "claim-detail", `Regal claim detail page opened for input row ${claimInput.rowNumber}, result ${claimRow.index + 1}. Iframe URL: ${regalContentUrl(page)}.`, page);

        const detailRows = await extractRegalClaimDetailRows(page);
        await stageLog(
          "info",
          "claim-detail",
          `Extracted Regal claim summary and ${detailRows.lineDetails.length} line detail row(s) for claim ${detailRows.summary.claimNumber || claimRow.claimNumber}.`,
          page,
        );

        const lines = detailRows.lineDetails.length ? detailRows.lineDetails : [{} as RegalLineDetailRow];
        for (const line of lines) {
          outputRows.push({
            "Account Number": claimInput.accountNumber,
            input_row_number: claimInput.rowNumber,
            input_group: claimInput.group,
            input_member_name: claimInput.memberName,
            input_dos: claimInput.dos,
            search_result_index: claimRow.index + 1,
            search_member_name: claimRow.memberName,
            search_member_hmo_id: claimRow.memberHmoId,
            search_provider_name: claimRow.providerName,
            search_claim_number: claimRow.claimNumber,
            search_first_date_of_service: claimRow.firstDateOfService,
            search_diagnosis: claimRow.diagnosis,
            search_billed: claimRow.billed,
            search_pay_amount: claimRow.payAmount,
            search_status: claimRow.status,
            provider: detailRows.summary.provider,
            specialty: detailRows.summary.specialty,
            claim_number: detailRows.summary.claimNumber,
            claim_date: detailRows.summary.claimDate,
            member_id_name: detailRows.summary.memberIdName,
            carrier: detailRows.summary.carrier,
            ...Object.fromEntries(Object.entries(line).map(([key, value]) => [`line_${normalizeColumnName(key)}`, value])),
          });
        }
      }

        completedRows += 1;
        await context.emit({ type: "progress", completed: completedRows, total: progressTotal });
        await emitOutputSnapshot(completedRows, progressTotal);

        if (claimInput !== groupBatch.rows[groupBatch.rows.length - 1]) {
          await returnToRegalClaimSearch(page, claimsSearchUrl);
        }
      }
    }

    if (totalSearchResults === 0 && outputRows.length === 0) {
      throw new Error("Regal claim search completed for all input rows, but no result rows were found.");
    }

    await emitOutputWorkbook();
    await context.emit({ type: "warning", message: `Regal claim extraction completed with ${outputRows.length} output row(s).` });
  };

  try {
    try {
      await runFlow(1);
    } catch (firstError) {
      const firstMessage = errorMessage(firstError);
      await stageLog("warn", "retry", `First Regal attempt failed: ${firstMessage}`);
      if (firstError instanceof RegalJobCancelledError) {
        throw firstError;
      }
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
    if (error instanceof RegalJobCancelledError) {
      await emitOutputWorkbook().catch((outputError) => {
        void context.log({ level: "error", message: `Failed to create Regal partial output workbook after cancellation: ${errorMessage(outputError)}` });
      });
      await emitLatestLog().catch((logError) => {
        void context.log({ level: "error", message: `Failed to create Regal latest log after cancellation: ${errorMessage(logError)}` });
      });
      await context.emit({ type: "cancelled", message });
      await context.emit({ type: "done" });
      return;
    }
    await stageLog("error", "failed", message);
    if (page) {
      await emitPageDiagnostics(context, page, "login-error", { error: true });
    }
    await emitOutputWorkbook().catch((outputError) => {
      void context.log({ level: "error", message: `Failed to create Regal partial output workbook: ${errorMessage(outputError)}` });
    });
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
