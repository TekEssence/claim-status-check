import type { Page } from "playwright-core";
import type { EligibilityInputRow, EligibilityResult } from "../../types";
import { normalizeWaystarDate } from "../waystar/dates";
import { mediCalDatesMatch, mediCalIssueDate } from './dates';
import { selectMediCalCalendarDate } from './calendar';

// Stable attributes from medical html elements.txt; login IDs are generated UUIDs.
export const selectors = {
  email: 'input[placeholder="Enter your Email Address"]:visible, input[placeholder="Email Address"]:visible, input[type="email"]:visible',
  password: 'input[placeholder="Enter your Password"]',
  subscriber: '#subscriber-id', issue: '#issue-date', birth: '#birth-date', service: '#service-date',
  status: '#status-area', medicare: '#medicare-id-label', name: '#subscriber-name-label',
};

export async function openMediCalLoginPage(page: Page, loginUrl: string) {

  try {
    const response = await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (response?.status() === 403) {
      const body = await page.locator('body').innerText();
      if (/block access from your country/i.test(body)) {
        throw new Error('Medi-Cal denied access from this network/country (HTTP 403). The website menu and login form were not loaded. Use a network/location authorized by the portal or contact Medi-Cal support.');
      }
      throw new Error('Medi-Cal denied access to the website (HTTP 403). No login was submitted.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('ERR_NAME_NOT_RESOLVED')) {
      throw new Error(`Cannot resolve the Medi-Cal portal hostname (${new URL(loginUrl).hostname}). Check DNS/network access on the machine running the automation, then retry. No login was submitted.`, { cause: error });
    }
    throw error;
  }
  if (['www.medi-cal.ca.gov', 'mcweb.apps.prd.cammis.medi-cal.ca.gov'].includes(new URL(page.url()).hostname)) {
    if (new URL(page.url()).pathname.replace(/\/$/, '') !== '/provider-portal') {
      const provider = page.locator('a[href="/provider-portal"]:visible').filter({ hasText: /^\s*(Login|Provider Portal)\s*$/i }).first();
      const login = page.locator('a[href="/provider-portal"]:visible').filter({ hasText: /^\s*Login\s*$/i }).first();
      const menu = page.locator('.ca-gov-icon-menu:visible').first();
      await provider.or(menu).first().waitFor({ state: 'visible', timeout: 60_000 });
      if (!await provider.isVisible()) await menu.click();
      await (await login.isVisible() ? login : provider).click({ timeout: 30_000 });
    }
  }
  await page.locator(selectors.email).waitFor({ state: 'visible', timeout: 60_000 });
}

type LoginOptions = {
  report?: (message: string) => Promise<void>;
  isCancelled?: () => boolean;
  timeoutMs?: number;
};

export async function waitForMediCalLogin(page: Page, options: LoginOptions = {}) {
  const report = options.report ?? (async () => {});
  const agreementName = /I confirm that I have read and agree to the above/i;
  const agreement = page.getByText(agreementName).and(page.locator(':visible'));
  const checkbox = page.getByRole('checkbox', { name: agreementName });
  const single = page.getByRole('button', { name: 'Single Subscriber', exact: true })
    .or(page.getByText('Single Subscriber', { exact: true })).first();
  const rejected = page.locator('[role="alert"], .alert, [aria-live="assertive"]').filter({ hasText: /invalid|incorrect|failed|denied|locked|try again/i });
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let accepted = false;
  while (Date.now() < deadline) {
    if (options.isCancelled?.()) throw new Error('Medi-Cal login cancelled.');
    if (page.isClosed()) throw new Error('Medi-Cal login browser was closed.');
    if (await page.locator(selectors.subscriber).isVisible()) return;
    if (await single.isVisible()) {
      await report('Medi-Cal login completed. Opening Single Subscriber.');
      await single.click();
      await page.locator(selectors.subscriber).waitFor({ state: 'visible', timeout: 60_000 });
      return;
    }
    if (await rejected.first().isVisible()) throw new Error('Medi-Cal displayed a login rejection. Review the portal message and confirm the account can sign in manually.');
    if (!accepted && await agreement.first().isVisible()) {
      await report('Medi-Cal agreement screen loaded. Confirming the agreement.');
      if (await checkbox.isVisible()) await checkbox.check();
      else await agreement.first().click();
      await page.getByRole('button', { name: 'Next', exact: true }).click();
      accepted = true;
    }
    // The agreement is not shown on every authenticated session.
    // Keep waiting for the actual destination instead of assuming login worked.
    const ready = accepted ? single.or(page.locator(selectors.subscriber)) : agreement.or(single).or(rejected);
    try { await ready.first().waitFor({ state: 'visible', timeout: Math.min(500, Math.max(1, deadline - Date.now())) }); }
    catch (error) { if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error; }
  }
  const stillLogin = await page.locator(selectors.password).isVisible();
  throw new Error(stillLogin
    ? 'Medi-Cal remained on the login page after submission; the agreement screen was not reached. Review the login diagnostics for a rejected request or network failure.'
    : 'Medi-Cal did not reach the agreement or eligibility page within the login wait period. Review the login diagnostics.');
}

export async function loginMediCal(page: Page, credentials: { loginUrl: string; username: string; password: string }, options: LoginOptions = {}) {
  const report = options.report ?? (async () => {});
  await openMediCalLoginPage(page, credentials.loginUrl);
  await page.locator(selectors.email).fill('');
  await page.locator(selectors.email).pressSequentially(credentials.username, { delay: 30 });
  await page.locator(selectors.email).press('Tab');
  if (await page.locator(selectors.email).inputValue() !== credentials.username) {
    throw new Error('Medi-Cal did not retain the email before submission.');
  }
  if (!await page.locator(selectors.password).isVisible()) {
    await page.getByRole('button', { name: /^Next$/i }).click();
    await report('Medi-Cal email submitted. Waiting for the password screen.');
  }
  await page.locator(selectors.password).waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator(selectors.password).fill('');
  await page.locator(selectors.password).pressSequentially(credentials.password, { delay: 30 });
  await page.locator(selectors.password).press('Tab');
  if ((await page.locator(selectors.email).isVisible() && await page.locator(selectors.email).inputValue() !== credentials.username) || await page.locator(selectors.password).inputValue() !== credentials.password) {
    throw new Error('Medi-Cal did not retain the login fields before submission.');
  }
  await page.getByRole('button', { name: /^(Log\s*In|Sign\s*In)$/i }).click();
  await report('Medi-Cal Log In clicked. Waiting for the agreement or eligibility page.');
  await waitForMediCalLogin(page, options);
  return page.url();
}

export async function extractMediCalResult(page: Page, rowIndex: number): Promise<EligibilityResult> {
  const description = (await page.locator(selectors.status).innerText()).trim();
  if (!description) throw new Error('Medi-Cal returned an empty eligibility result.');
  if (/transaction could not be processed|system error|system is unavailable|temporarily unavailable|service unavailable|session (?:has )?expired/i.test(description)) {
    throw new Error(`Medi-Cal eligibility verification failed; no eligibility data was returned. Portal message: ${description}`);
  }
  const fields = await page.evaluate(({ medicare, name }) => {
    const [read] = [(selector: string, title: string) => {
      const label = document.querySelector(selector);
      const [readValue] = [(element: Element | null) => {
        if (!element || element.id.endsWith('-label') || element.querySelector('[id$="-label"], label, th, dt')) return '';
        const text = element instanceof HTMLInputElement ? element.value : (element.textContent || '').trim();
        if (text === title || /^(?:Medicare ID|Subscriber Name)\s*[:#]?$/i.test(text)) return '';
        return text;
      }];
      if (label) {
        const associated = label instanceof HTMLLabelElement && label.htmlFor ? document.getElementById(label.htmlFor) : null;
        const labelled = document.querySelector(`[aria-labelledby="${label.id}"]`);
        const direct = readValue(associated) || readValue(labelled) || readValue(label.nextElementSibling);
        if (direct) return direct;
        // Some layouts wrap the label in a cell/container separate from its value.
        const parent = label.parentElement;
        if (parent && parent.textContent?.trim() === label.textContent?.trim()) {
          const adjacent = readValue(parent.nextElementSibling);
          if (adjacent) return adjacent;
        }
      }
      return '';
    }];
    return { medicareId: read(medicare, 'Medicare ID'), subscriberName: read(name, 'Subscriber Name') };
  }, selectors);
  // Negative eligibility must be checked first: "not eligible" contains "eligible".
  const coverageStatus = /\b(?:not eligible|ineligible|inactive coverage)\b/i.test(description)
    ? 'inactive'
    : /\b(?:medi-cal\s+(?:is\s+)?eligible|subscriber\s+is\s+eligible|eligible\s+for\s+(?:medi-cal|benefits)|active coverage)\b/i.test(description)
      ? 'active' : 'unknown';
  return { rowIndex, payerId: 'medical', coverageStatus, benefits: [],
    coverageDescription: description,
    patientName: fields.subscriberName || description.match(/\bSUBSCRIBER NAME\s*[:#]\s*([^\r\n.;]+)/i)?.[1]?.trim() || '',
    metadata: { medicareId: fields.medicareId || description.match(/\bMEDICARE ID\s*[:#]\s*([A-Z0-9-]+)/i)?.[1] || '' } };
}

export async function verifyMediCalRow(page: Page, inquiryUrl: string, row: EligibilityInputRow, report: (message: string) => Promise<void> = async () => {}) {
  const subscriber = row.memberId || row.subscriberId || '';
  const issue = mediCalIssueDate();
  if (!subscriber || !row.dateOfBirth || !row.dateOfService) {
    throw new Error('Medi-Cal requires Member ID, Date of Birth, and DOS.');
  }
  const fields = [
    [selectors.subscriber, subscriber], [selectors.issue, normalizeWaystarDate(issue)],
    [selectors.birth, normalizeWaystarDate(row.dateOfBirth)], [selectors.service, normalizeWaystarDate(row.dateOfService)],
  ];
  // Reopen the inquiry for every row so a previous subscriber response cannot
  // satisfy the result wait, including after a failed or timed-out request.
  await page.goto(inquiryUrl, { waitUntil: 'domcontentloaded' });
  await page.locator(selectors.subscriber).waitFor({ state: 'visible' });
  if (await page.locator(selectors.status).count()) throw new Error('Medi-Cal inquiry contains a stale result before search.');
  for (const [selector, entry] of fields) {
    if (selector === selectors.subscriber) {
      await page.locator(selector).fill(entry);
      await page.locator(selector).press('Tab');
    } else {
      await selectMediCalCalendarDate(page, selector, entry);
    }
  }
  for (const [selector, entry] of fields) {
    const actual = await page.locator(selector).inputValue();
    if (selector === selectors.subscriber ? actual !== entry : !mediCalDatesMatch(actual, entry)) throw new Error('Medi-Cal did not retain the requested inquiry fields.');
  }
  await report('Inquiry fields verified. Searching Medi-Cal eligibility.');
  await page.getByText('Search', { exact: true }).click();
  await page.locator(selectors.status).waitFor({ state: 'visible', timeout: 60_000 });
  return extractMediCalResult(page, row.originalIndex);
}
