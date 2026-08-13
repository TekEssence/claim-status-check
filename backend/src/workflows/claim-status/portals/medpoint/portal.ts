import type { Page } from "playwright-core";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { ScraperContext } from "../../types";
import { medpointConfig } from "./config";
import type { MedpointCredentials, MedpointInputRow } from "./types";

const CAPTCHA_INPUT_NAME = "medpoint_recaptcha_completed";
const OTP_INPUT_NAME = "medpoint_otp";

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parseMoney(value: string): number {
  const numeric = Number(String(value || "").replace(/[^0-9.-]+/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

async function isVisible(page: Page, selector: string, timeout = 1500): Promise<boolean> {
  return page.locator(selector).first().isVisible({ timeout }).catch(() => false);
}

async function firstVisible(page: Page, selectors: string[], timeout = 5000) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout }).catch(() => {});
    if (await locator.isVisible({ timeout: 200 }).catch(() => false)) return locator;
  }
  return null;
}

async function clickFirstVisible(page: Page, selectors: string[], timeout = 5000): Promise<boolean> {
  const locator = await firstVisible(page, selectors, timeout);
  if (!locator) return false;
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.click({ timeout: 5000 }).catch(async () => {
    await locator.click({ force: true, timeout: 5000 });
  });
  return true;
}

async function ensureMedpointSignIn(page: Page, log: (message: string) => Promise<void>): Promise<void> {
  const signInSelectors = [
    medpointConfig.selectors.signIn,
    'button[type="submit"]',
    'button:has-text("Sign in")',
    '[role="button"]:has-text("Sign in")',
    'input[type="submit"]',
    '.mat-mdc-raised-button:has-text("Sign in")',
    '.mat-mdc-unelevated-button:has-text("Sign in")',
    '.mat-mdc-button-touch-target',
  ];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1200);

    const alreadyAdvanced =
      (await isVisible(page, medpointConfig.selectors.otpInput, 1500)) ||
      (await isPortalHomeReady(page)) ||
      !(await isVisible(page, medpointConfig.selectors.username, 1000));
    if (alreadyAdvanced) {
      await log(`Medpoint login already advanced before Sign in retry ${attempt}.`);
      return;
    }

    await log(`Attempting Medpoint Sign in click after captcha (try ${attempt}/3).`);
    const clicked = await clickFirstVisible(page, signInSelectors, 12000);
    if (!clicked) {
      await log(`Medpoint Sign in button was not visible on try ${attempt}/3.`);
      continue;
    }

    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const advancedAfterClick =
      (await isVisible(page, medpointConfig.selectors.otpInput, 2000)) ||
      (await isPortalHomeReady(page)) ||
      !(await isVisible(page, medpointConfig.selectors.username, 1000));
    if (advancedAfterClick) {
      await log(`Medpoint Sign in click succeeded on try ${attempt}/3.`);
      return;
    }

    await log(`Medpoint Sign in click did not advance the page on try ${attempt}/3.`);
  }

  throw new Error(`Medpoint Sign in button was not able to advance the login flow after captcha. Current URL: ${page.url()}`);
}

async function ensureMedpointOtpValidation(page: Page, log: (message: string) => Promise<void>): Promise<void> {
  const otpValidateSelectors = [
    medpointConfig.selectors.otpValidate,
    'button:has-text("Validate OTP")',
    '[role="button"]:has-text("Validate OTP")',
    'button:has-text("Validate")',
    '[role="button"]:has-text("Validate")',
    'button[type="submit"]',
    'button:has-text("Continue")',
  ];

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.waitForTimeout(800);

    const alreadyAdvanced =
      !(await isVisible(page, medpointConfig.selectors.otpInput, 1000)) ||
      (await isPortalHomeReady(page));
    if (alreadyAdvanced) {
      await log(`Medpoint OTP already advanced before Validate click retry ${attempt}.`);
      return;
    }

    await log(`Attempting Medpoint Validate OTP click (try ${attempt}/3).`);
    const clicked = await clickFirstVisible(page, otpValidateSelectors, 10000);
    if (!clicked) {
      await log(`Medpoint Validate OTP button was not visible on try ${attempt}/3.`);
      continue;
    }

    await page.waitForLoadState("networkidle", { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(1500);

    const advancedAfterClick =
      !(await isVisible(page, medpointConfig.selectors.otpInput, 1500)) ||
      (await isPortalHomeReady(page));
    if (advancedAfterClick) {
      await log(`Medpoint Validate OTP click succeeded on try ${attempt}/3.`);
      return;
    }

    await log(`Medpoint Validate OTP click did not advance the page on try ${attempt}/3.`);
  }

  throw new Error(`Medpoint OTP was entered, but the portal did not advance after Validate OTP. Current URL: ${page.url()}`);
}

async function fillField(page: Page, selector: string, value: string): Promise<void> {
  const field = await page.locator(selector).first();
  await field.waitFor({ state: "visible", timeout: 20000 });
  await field.click();
  await page.keyboard.press("Control+A").catch(() => {});
  await field.fill(value);
  await field.dispatchEvent("input").catch(() => {});
  await field.dispatchEvent("change").catch(() => {});
}

async function isPortalHomeReady(page: Page): Promise<boolean> {
  const selectors = medpointConfig.selectors;
  const currentUrl = page.url().toLowerCase();
  if (currentUrl.includes('/claim') || currentUrl.includes('/dashboard') || currentUrl.includes('/home')) {
    return true;
  }

  return (
    (await isVisible(page, selectors.claimsMenu, 2500)) ||
    (await isVisible(page, selectors.currentIpa, 2500)) ||
    (await isVisible(page, selectors.memberLastName, 1500)) ||
    (await isVisible(page, selectors.memberFirstName, 1500)) ||
    (await isVisible(page, selectors.serviceFromDate, 1500)) ||
    (await isVisible(page, selectors.claimLink, 1500))
  );
}

async function requestCaptchaCompletion(context: ScraperContext, log: (message: string) => Promise<void>): Promise<void> {
  await log("Medpoint reCAPTCHA detected. Waiting for user completion in the real portal window.");
  await context.emit({
    type: "input_request",
    inputName: CAPTCHA_INPUT_NAME,
    label: "Medpoint captcha",
    message: 'Complete "I\'m not a robot" in the Medpoint browser window, then click Completed here to resume automation.',
    timeoutMs: 600000,
  });
  const value = await waitForScrapeJobInput(context.jobId, CAPTCHA_INPUT_NAME, 600000);
  if (normalizeText(value) !== "completed") throw new Error("Medpoint captcha step was not confirmed.");
}

async function requestOtp(context: ScraperContext, log: (message: string) => Promise<void>): Promise<string> {
  await log("Medpoint OTP page detected. Waiting for OTP entry from the frontend.");
  await context.emit({
    type: "input_request",
    inputName: OTP_INPUT_NAME,
    label: "Medpoint OTP",
    message: "Enter the Medpoint OTP code to continue.",
    timeoutMs: 300000,
  });
  return waitForScrapeJobInput(context.jobId, OTP_INPUT_NAME, 300000);
}

export async function loginToMedpoint(options: {
  page: Page;
  credentials: MedpointCredentials;
  context: ScraperContext;
  log: (message: string) => Promise<void>;
}): Promise<void> {
  const { page, credentials, context, log } = options;
  const selectors = medpointConfig.selectors;

  await log(`Opening Medpoint login URL: ${credentials.loginUrl}`);
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await fillField(page, selectors.username, credentials.username);
  await fillField(page, selectors.password, credentials.password);

  if (await isVisible(page, selectors.recaptcha, 3000)) {
    await requestCaptchaCompletion(context, log);
    await log("Captcha completion was confirmed from the frontend. Resuming Medpoint login.");
  }

  await ensureMedpointSignIn(page, log);
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  if (await isVisible(page, selectors.otpInput, 12000)) {
    const otp = await requestOtp(context, log);
    await log("OTP was received from the frontend. Filling it into the Medpoint portal.");
    await fillField(page, selectors.otpInput, otp);
    await ensureMedpointOtpValidation(page, log);
    await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  }

  const reachedPortal = await isPortalHomeReady(page);
  if (!reachedPortal) {
    throw new Error(`Medpoint login did not reach the portal home page. Current URL: ${page.url()}`);
  }
  await log("Medpoint login completed.");
}

export async function detectCurrentIpa(page: Page): Promise<string> {
  const texts = await page.locator(medpointConfig.selectors.currentIpa).allTextContents().catch(() => []);
  return texts.map((item) => item.trim()).filter(Boolean)[0] || "";
}

export function expectedIpaForRow(row: MedpointInputRow): string {
  const year = row.serviceFromDate.slice(-4);
  if (year === "2026") return "Optum Care Network-Inland Faculty Medical Group";
  if (year === "2024" || year === "2025") return "OIFMG HISTORY";
  return "";
}

export async function openClaimsSearch(page: Page, log: (message: string) => Promise<void>): Promise<void> {
  const claimsOpened = await clickFirstVisible(page, [medpointConfig.selectors.claimsMenu], 10000);
  if (claimsOpened) {
    await page.waitForTimeout(1000);
  }

  const searchOpened = await clickFirstVisible(page, [medpointConfig.selectors.searchAction], 8000);
  if (searchOpened) {
    await page.waitForTimeout(1000);
  }

  await log(`Medpoint Claims search view opened${claimsOpened ? '' : ' using the already-visible search form'}.`);
}

export async function searchClaims(page: Page, row: MedpointInputRow, log: (message: string) => Promise<void>): Promise<string[]> {
  await fillField(page, medpointConfig.selectors.memberLastName, row.memberLastName);
  await fillField(page, medpointConfig.selectors.memberFirstName, row.memberFirstName);
  await fillField(page, medpointConfig.selectors.serviceFromDate, row.serviceFromDate);
  await fillField(page, medpointConfig.selectors.serviceToDate, row.serviceToDate);
  await clickFirstVisible(page, [medpointConfig.selectors.searchAction, 'button[type="submit"]'], 8000);
  await log(`Medpoint search submitted for ${row.memberLastName}, ${row.memberFirstName} ${row.serviceFromDate}-${row.serviceToDate}.`);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const hrefs = await page.locator(medpointConfig.selectors.claimLink).evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).href).filter(Boolean)).catch(() => [] as string[]);
  return Array.from(new Set(hrefs));
}

export async function openClaimDetail(page: Page, href: string): Promise<void> {
  await page.goto(href, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

export async function extractClaimDetail(page: Page): Promise<{
  claimNumber: string;
  checkNumber: string;
  dateReceived: string;
  datePaid: string;
  patientAccount: string;
  providerName: string;
  details: Array<Record<string, string>>;
  codeDetails: Array<Record<string, string>>;
}> {
  return page.evaluate(() => {
    const text = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const labeledValue = (labelText: string) => {
      const labels = Array.from(document.querySelectorAll('label, .mat-form-field-label, .mat-card-title, .mat-static-content-content'));
      const target = labels.find((node) => text(node.textContent).toLowerCase() === labelText.toLowerCase());
      if (!target) return "";
      const container = target.closest('.mat-form-field-infix, mat-card, div, section') || target.parentElement;
      if (!container) return "";
      const valueNode = container.querySelector('.mat-static-content-content');
      return text(valueNode?.textContent);
    };

    const providerLinks = Array.from(document.querySelectorAll('a[href*="/providers/"]'));
    const providerName = text(providerLinks[0]?.textContent);

    const titles = Array.from(document.querySelectorAll('mat-card-title, .mat-card-title')).map((node) => ({
      node,
      value: text(node.textContent),
    }));

    function rowsForSection(titleText: string) {
      const title = titles.find((item) => item.value.toLowerCase() === titleText.toLowerCase())?.node;
      if (!title) return [] as Array<Record<string, string>>;
      let cursor: Element | null = title.parentElement?.nextElementSibling || title.nextElementSibling;
      const tables: HTMLTableElement[] = [];
      while (cursor) {
        if (cursor.matches('mat-card-title, .mat-card-title')) break;
        if (cursor instanceof HTMLTableElement) tables.push(cursor);
        tables.push(...Array.from(cursor.querySelectorAll('table')));
        cursor = cursor.nextElementSibling;
      }
      const results: Array<Record<string, string>> = [];
      for (const table of tables) {
        const trs = Array.from(table.querySelectorAll('tr')).filter((tr) => text(tr.textContent));
        if (trs.length < 2) continue;
        const headers = Array.from(trs[0].querySelectorAll('th,td')).map((cell) => text(cell.textContent));
        for (const tr of trs.slice(1)) {
          const cells = Array.from(tr.querySelectorAll('td,th')).map((cell) => text(cell.textContent));
          if (cells.length == 0) continue;
          const joined = cells.join(' ').toLowerCase();
          if (joined.includes('subtotal') || joined == 'total' || joined.startsWith('total ')) continue;
          const row: Record<string, string> = {};
          headers.forEach((header, index) => {
            row[header || `column_${index + 1}`] = cells[index] || "";
          });
          results.push(row);
        }
      }
      return results;
    }

    return {
      claimNumber: labeledValue('Claim#') || text(document.querySelector('.mat-static-content-content')?.textContent),
      checkNumber: labeledValue('Check'),
      dateReceived: labeledValue('Date Received'),
      datePaid: labeledValue('Date Paid'),
      patientAccount: labeledValue('Patient Account #'),
      providerName,
      details: rowsForSection('Details'),
      codeDetails: rowsForSection('Code Details'),
    };
  });
}

export function buildOutputRows(row: MedpointInputRow, ipaContext: string, resultIndex: number, detail: Awaited<ReturnType<typeof extractClaimDetail>>) {
  const codeDetail = detail.codeDetails[0] || {};
  const codeEntries = Object.entries(codeDetail);
  const codeValue = codeEntries.find(([key]) => normalizeText(key).includes('code'))?.[1] || '';
  const descriptionValue = codeEntries.find(([key]) => normalizeText(key).includes('desc'))?.[1] || codeEntries.find(([key]) => normalizeText(key).includes('reason'))?.[1] || '';

  const detailRows = detail.details.length > 0 ? detail.details : [{}];
  return detailRows.map((line, index) => {
    const entries = Object.entries(line);
    const netEntry = entries.find(([key]) => normalizeText(key).includes('net'));
    const statusEntry = entries.find(([key]) => normalizeText(key).includes('status'));
    const lineEntry = entries.find(([key]) => normalizeText(key).includes('line'));
    const netAmount = netEntry?.[1] || '';
    const rawStatus = statusEntry?.[1] || '';
    const finalStatus = parseMoney(netAmount) > 0 ? 'Paid' : (descriptionValue || codeValue ? 'Denied' : (rawStatus || 'Pending'));
    return {
      input_row_number: row.inputRowNumber,
      input_member_last_name: row.memberLastName,
      input_member_first_name: row.memberFirstName,
      input_service_from_date: row.serviceFromDate,
      input_service_to_date: row.serviceToDate,
      input_claim_number: row.claimNumber,
      ipa_context: ipaContext,
      search_result_index: resultIndex,
      portal_claim_number: detail.claimNumber,
      portal_check_number: detail.checkNumber,
      portal_date_received: detail.dateReceived,
      portal_date_paid: detail.datePaid,
      portal_patient_account: detail.patientAccount,
      portal_provider_name: detail.providerName,
      detail_line_number: lineEntry?.[1] || `${index + 1}`,
      detail_raw_status: rawStatus,
      detail_net_amount: netAmount,
      denial_code: parseMoney(netAmount) > 0 ? '' : codeValue,
      denial_description: parseMoney(netAmount) > 0 ? '' : descriptionValue,
      final_status: finalStatus,
      bot_notes: finalStatus === 'Paid' ? 'Net amount greater than zero in Medpoint details.' : (descriptionValue || codeValue || rawStatus || 'No matching claim detail lines were found.'),
    };
  });
}
