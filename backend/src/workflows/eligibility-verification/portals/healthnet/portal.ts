import type { Frame, Locator, Page, Response } from "playwright-core";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { AutomationContext } from "../../../types";
import type { EligibilityInputRow, EligibilityResult } from "../../types";
import { normalizeWaystarDate } from "../waystar/dates";

// Selectors from healthnet portal html element.md. The phone suffix and
// today's eligibility date are account/response data, never selector constants.
export const selectors = {
  username: '#username', next: '#nextButton', password: '#password', login: '#loginButton',
  textMessage: 'span.MuiFormControlLabel-label', sendCode: '#continueMfa',
  member: 'input[name="memberIdOrLastName"]', dob: 'input[name="dob"]',
  eligibility: 'a.eligibility[href="/careconnect/eligibility/bulkChecker"]',
  search: 'input[type="submit"][name="check"][value="Check Eligibility"], button[name="submit"][type="submit"]',
  viewDetails: 'span.viewdetails',
  viewPpgHistory: '#viewPpgHistoryButton',
  alert: 'div.alert.big', title: 'h4.title', product: '#elig_hist_productname',
};

export const HEALTHNET_LOGIN_WAIT_MS = 180_000;

function healthNetPortalReady(page: Page) {
  return page.locator(selectors.member)
    .or(page.getByRole('link', { name: /^Eligibility$/i }))
    .or(page.getByRole('button', { name: /^Eligibility$/i }))
    .filter({ visible: true });
}

async function openHealthNetEligibility(page: Page, context: AutomationContext) {
  await waitForHealthNetLoginScreen(page, healthNetPortalReady(page).first(), context, 'dashboard or eligibility search screen');
  if (isHealthNetDashboard(page) || !await page.locator(selectors.member).isVisible()) {
    await context.log({ level: 'info', message: 'Health Net login succeeded. Opening Eligibility from the dashboard.', eventName: 'eligibility_healthnet_dashboard' });
    const exact = page.locator(selectors.eligibility).filter({ visible: true });
    const eligibility = await exact.count() ? exact : page.getByRole('link', { name: /^Eligibility$/i })
      .or(page.getByRole('button', { name: /^Eligibility$/i })).filter({ visible: true });
    await eligibility.click({ timeout: HEALTHNET_LOGIN_WAIT_MS });
  }
  await waitForHealthNetLoginScreen(page, page.locator(selectors.member), context, 'eligibility search screen');
  await page.locator(selectors.member).scrollIntoViewIfNeeded();
  return page.url();
}

function isHealthNetDashboard(page: Page) {
  return /\/careconnect\/home\/?$|\/home\/?$/i.test(new URL(page.url()).pathname);
}

export async function fillHealthNetDate(field: Locator, value: string, label: string) {
  const normalized = normalizeWaystarDate(value);
  await field.scrollIntoViewIfNeeded();
  for (let attempt = 0; attempt < 2; attempt++) {
    await field.click();
    await field.press('ControlOrMeta+A');
    await field.press('Backspace');
    if (await field.getAttribute('type') === 'date') {
      const [month, day, year] = normalized.split('/');
      await field.fill(`${year}-${month}-${day}`);
    } else {
      // The mask inserts separators itself. Clear through keyboard events so
      // its internal buffer and caret reset, then enter only the date digits.
      await field.press('Home');
      const masked = (await field.getAttribute('class') || '').split(/\s+/).includes('mask-date');
      await field.pressSequentially(masked && attempt === 0 ? normalized.replace(/\D/g, '') : normalized, { delay: 100 });
    }
    await field.press('Tab');
    try { if (normalizeWaystarDate(await field.inputValue()) === normalized) return; } catch { /* Retry without discarding validation. */ }
  }
  throw new Error(`Health Net did not retain ${label}. Check Eligibility was not submitted.`);
}

async function fillHealthNetMember(page: Page, memberId: string, dob: string, dos?: string) {
  if (dos) await fillHealthNetDate(page.locator('input#dos[name=dos]').filter({ visible: true }), dos, 'DOS');
  const member = page.locator(selectors.member).filter({ visible: true });
  await member.scrollIntoViewIfNeeded();
  await member.fill('');
  await member.pressSequentially(memberId, { delay: 75 });
  await member.press('Tab');
  await fillHealthNetDate(page.locator(selectors.dob).filter({ visible: true }), dob, 'DOB');
  if ((await member.inputValue()).trim() !== memberId.trim()) throw new Error('Health Net did not retain Member ID. Check Eligibility was not submitted.');
}

export async function selectHealthNetTextMessage(page: Page, context: AutomationContext) {
  const name = /^\s*Text Message\s*:/i;
  const radio = page.getByRole('radio', { name }).and(page.locator(':visible'));
  const label = page.locator(selectors.textMessage).filter({ hasText: name }).and(page.locator(':visible'));
  // Wait for either rendering of the same SMS option. The first match here is
  // only a readiness signal; selection below still rejects multiple recipients.
  await waitForHealthNetLoginScreen(page, radio.or(label).first(), context, 'Text Message verification screen');
  if (await radio.count()) {
    if (await radio.count() !== 1) throw new Error('Health Net shows multiple Text Message recipients. Unable to select one uniquely.');
    await radio.scrollIntoViewIfNeeded();
    await radio.check({ timeout: HEALTHNET_LOGIN_WAIT_MS });
    if (!(await radio.isChecked())) throw new Error('Health Net did not select Text Message.');
  } else {
    if (await label.count() !== 1) throw new Error('Health Net Text Message option is ambiguous.');
    await label.scrollIntoViewIfNeeded();
    await label.click({ timeout: HEALTHNET_LOGIN_WAIT_MS });
    const associatedRadio = label.locator('xpath=ancestor::label[1]').locator('input[type="radio"]');
    if (await associatedRadio.count() === 1 && !(await associatedRadio.isChecked())) throw new Error('Health Net did not select Text Message.');
  }
  await context.log({ level: 'info', message: 'Health Net authentication screen loaded. Text Message selected; sending the code.', eventName: 'eligibility_healthnet_sms_selected' });
  const send = page.locator(selectors.sendCode).or(page.getByRole('button', { name: /^Send Code$/i })).and(page.locator(':visible:enabled'));
  await send.click({ timeout: HEALTHNET_LOGIN_WAIT_MS });
}

export async function waitForHealthNetLoginScreen(page: Page, target: Locator, context: AutomationContext, screen: string, timeoutMs = HEALTHNET_LOGIN_WAIT_MS, stopOnRepeatedDenial = true) {
  let authenticationFailed = false;
  let deniedCallbacks = 0;
  const inspectResponse = (response: Response) => {
    const url = new URL(response.url());
    if (url.hostname === 'provider.healthnetcalifornia.com' && url.pathname.includes('/login/oauth2/code')
      && url.searchParams.get('error') === 'access_denied') {
      authenticationFailed = true;
      deniedCallbacks++;
    }
  };
  const inspectRedirect = (frame: Frame) => {
    if (frame !== page.mainFrame()) return;
    const url = new URL(frame.url());
    if (url.searchParams.get('error') === 'access_denied' || /authentication[ +]failed/i.test(url.searchParams.get('error_description') || '')) authenticationFailed = true;
  };
  page.on('framenavigated', inspectRedirect);
  page.on('response', inspectResponse);
  inspectRedirect(page.mainFrame());
  const deadline = Date.now() + timeoutMs;
  let nextNotice = 0;
  try {
    while (Date.now() < deadline) {
      if (context.isCancelled?.()) throw new Error('Health Net login cancelled.');
      if (page.isClosed()) throw new Error('Health Net login browser was closed.');
      if (stopOnRepeatedDenial && deniedCallbacks >= 3) throw new Error('Health Net authentication was denied three times. Stopped the repeated sign-in redirects; the OTP screen was not reached.');
      if (Date.now() >= nextNotice) {
        await context.log({ level: 'info', message: `Waiting for Health Net ${screen} to load. Login redirects can take up to ${Math.ceil(timeoutMs / 1000)} seconds.`, eventName: 'eligibility_healthnet_login_wait' });
        nextNotice = Date.now() + 30_000;
      }
      try {
        await target.waitFor({ state: 'visible', timeout: Math.min(5_000, Math.max(1, deadline - Date.now())) });
        return;
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error;
      }
    }
    throw new Error(authenticationFailed
      ? `Health Net returned Authentication failed / access_denied during login and did not reach ${screen} within ${Math.ceil(timeoutMs / 1000)} seconds. Please check that this account can sign in to Health Net manually.`
      : `Health Net ${screen} did not load within ${Math.ceil(timeoutMs / 1000)} seconds. The login redirects may still be loading or the expected screen was not displayed.`);
  } finally {
    page.off('framenavigated', inspectRedirect);
    page.off('response', inspectResponse);
  }
}

export async function enterHealthNetUsername(page: Page, username: string, context: AutomationContext) {
  const field = page.locator(selectors.username).filter({ visible: true });
  await waitForHealthNetLoginScreen(page, field, context, 'email address screen');
  for (let attempt = 0; attempt < 3; attempt++) {
    if (context.isCancelled?.()) throw new Error('Health Net login cancelled.');
    await field.scrollIntoViewIfNeeded();
    // Fill the full email at once to avoid losing characters during rendering.
    // Retry with keyboard events if the portal rejects programmatic input.
    if (attempt === 0) await field.fill(username);
    else {
      await field.click();
      await field.press('ControlOrMeta+A');
      await field.press('Backspace');
      await field.pressSequentially(username, { delay: 80 });
    }
    await field.press('Tab');
    await page.waitForTimeout(300);
    if (await field.inputValue() === username) {
      await page.waitForTimeout(300);
      if (await field.inputValue() === username) return;
    }
    await context.log({ level: 'info', message: 'Health Net changed the email field while loading. Re-entering the complete username before Continue.', eventName: 'eligibility_healthnet_username_retry' });
  }
  throw new Error('Health Net did not retain the complete username after three entry attempts. Continue was not clicked.');
}

export async function loginHealthNet(page: Page, credentials: { username: string; password: string; loginUrl: string }, context: AutomationContext) {
  await page.goto(credentials.loginUrl, { waitUntil: 'domcontentloaded', timeout: HEALTHNET_LOGIN_WAIT_MS });
  await enterHealthNetUsername(page, credentials.username, context);
  await page.locator(selectors.next).click({ timeout: HEALTHNET_LOGIN_WAIT_MS });
  await waitForHealthNetLoginScreen(page, page.locator(selectors.password), context, 'password screen');
  await page.locator(selectors.password).fill('');
  await page.locator(selectors.password).pressSequentially(credentials.password, { delay: 40 });
  await page.locator(selectors.password).press('Tab');
  if (await page.locator(selectors.password).inputValue() !== credentials.password) throw new Error('Health Net did not retain the password before submission.');
  await context.log({ level: 'info', message: 'Submitting Health Net login. Waiting for verification or the signed-in dashboard.', eventName: 'eligibility_healthnet_login_submitted' });
  await page.locator(selectors.login).click({ timeout: HEALTHNET_LOGIN_WAIT_MS });
  return completeHealthNetAuthentication(page, context);
}

export async function recoverHealthNetLogin(page: Page, loginUrl: string, context: AutomationContext, timeoutMs = 10 * 60 * 1000) {
  if (context.isCancelled?.() || page.isClosed()) throw new Error('Health Net login recovery cancelled or browser closed.');
  await context.log({ level: 'warn', eventName: 'eligibility_healthnet_manual_login',
    message: 'Automatic Health Net login did not reach verification. Resetting the Health Net / EntryKeyID session before manual sign-in. The browser will remain open for up to 10 minutes. Enter your username and password in the bot browser and stop at the Text Message / E-Mail selection screen. The bot will resume automatically and request the text message code here.' });
  // Stop the old document before clearing cookies that could resume the denial loop.
  await page.goto('about:blank', { waitUntil: 'commit', timeout: 15_000 });
  await page.context().clearCookies({ domain: /(^|\.)(entrykeyid\.com|healthnetcalifornia\.com|healthnet\.com)$/i });
  try {
    await page.goto(loginUrl, { waitUntil: 'commit', timeout: 30_000 });
  } catch (error) {
    const interrupted = error instanceof Error && (error.name === 'TimeoutError' || /ERR_ABORTED|interrupted by another navigation/i.test(error.message));
    if (!interrupted || page.isClosed()) throw error;
    await context.log({ level: 'warn', eventName: 'eligibility_healthnet_recovery_navigation',
      message: 'Health Net interrupted the login navigation. The browser remains open: use its address bar to open your Health Net login page and sign in manually.' });
  }
  // Never submit credentials again or bypass the site's authentication. Wait
  // for the user to reach the actual MFA screen in this same session.
  const ready = page.getByRole('radio', { name: /^\s*Text Message\s*:/i })
    .or(page.locator(selectors.textMessage).filter({ hasText: /^\s*Text Message\s*:/i }))
    .or(healthNetPortalReady(page)).and(page.locator(':visible')).first();
  await waitForHealthNetLoginScreen(page, ready, context, 'manual sign-in: complete login in the bot browser', timeoutMs, false);
  if (await page.locator(selectors.member).isVisible()) return page.url();
  return completeHealthNetAuthentication(page, context);
}

export async function completeHealthNetAuthentication(page: Page, context: AutomationContext) {
  const textMessage = page.getByRole('radio', { name: /^\s*Text Message\s*:/i })
    .or(page.locator(selectors.textMessage).filter({ hasText: /^\s*Text Message\s*:/i }))
    .filter({ visible: true });
  // Health Net sometimes accepts the session without requesting another OTP.
  // Watch both outcomes throughout the redirect, not just once after Login.
  await waitForHealthNetLoginScreen(page, textMessage.or(healthNetPortalReady(page)).first(), context, 'verification screen or signed-in dashboard');
  if (await healthNetPortalReady(page).count()) return openHealthNetEligibility(page, context);
  await selectHealthNetTextMessage(page, context);
  // The supplied file omits the OTP entry and verify button HTML. Resolve
  // their accessible labels/standard autocomplete rather than guessing IDs.
  const otp = page.getByRole('textbox', { name: /verification code|security code|one.time.*code|passcode|^code$/i })
    .or(page.getByPlaceholder(/^(enter )?(verification |security )?code$/i))
    .or(page.locator('input[autocomplete="one-time-code"]')).and(page.locator(':visible'));
  await waitForHealthNetLoginScreen(page, otp, context, 'verification code entry screen');
  const timeoutMs = 10 * 60 * 1000;
  const inputName = `healthnet_otp_${crypto.randomUUID()}`;
  await context.emit({ type: 'otp_request', inputName, label: 'Health Net text message verification code',
    message: 'Enter the code sent by Health Net by text message, then click Submit code.', timeoutMs });
  const code = (await waitForScrapeJobInput(context.jobId, inputName, timeoutMs)).trim();
  if (!code) throw new Error('Health Net verification code is empty.');
  await otp.fill('');
  await otp.pressSequentially(code, { delay: 75 });
  await otp.press('Tab');
  if (await otp.inputValue() !== code) throw new Error('Health Net did not retain the verification code.');
  const otpForm = otp.locator('xpath=ancestor::form[1]');
  const verifyScope = await otpForm.count() === 1 ? otpForm : page.locator('body');
  await verifyScope.getByRole('button', { name: /^(verify|verify code|submit|continue|validate|validate code)$/i })
    .and(page.locator(':visible:enabled:not(#nextButton):not(#loginButton):not(#continueMfa)')).click({ timeout: HEALTHNET_LOGIN_WAIT_MS });
  return openHealthNetEligibility(page, context);
}

export function healthNetMemberIdsMatch(actual: string, expected: string) {
  // MedRevenue accepts the portal's optional three-character trailing suffix.
  // All characters in the shared base, including leading zeros, must match.
  const normalize = (value: string) => value.trim().replace(/[\s-]/g, '').toUpperCase();
  const portalId = normalize(actual), inputId = normalize(expected);
  if (!portalId || !inputId) return false;
  if (portalId === inputId) return true;
  const shorter = portalId.length < inputId.length ? portalId : inputId;
  const longer = portalId.length < inputId.length ? inputId : portalId;
  return longer.length === shorter.length + 3 && longer.startsWith(shorter)
    && /^[A-Z0-9]{3}$/.test(longer.slice(shorter.length));
}

export class HealthNetMemberMismatchError extends Error {
  constructor(public readonly requestedMemberId: string, public readonly extractedMemberId: string) {
    super('Health Net result Member ID differs from the requested ID. Download healthnet-member-comparison diagnostics to compare the two values. No result was saved for this row.');
    this.name = 'HealthNetMemberMismatchError';
  }
}

export async function extractHealthNetResult(page: Page, rowIndex: number): Promise<EligibilityResult> {
  const data = await page.evaluate(() => {
    // Avoid named arrow helpers that tsx would serialize into browser code.
    const [clean, visible] = [
      (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() || '',
      (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
    ] as const;
    const alerts = Array.from(document.querySelectorAll('div.alert.big')).filter(visible)
      .filter(el => /\bpatient\b.*\beligib/i.test(clean(el)));
    if (alerts.length !== 1) throw new Error('Health Net patient eligibility message is missing or ambiguous.');
    const status = clean(alerts[0]);
    const headings: Element[] = Array.from(document.querySelectorAll('h3')).filter(visible);
    const ppg = headings.filter(el => clean(el) === 'PPG Information');
    const history = headings.filter(el => clean(el) === 'Eligibility History');
    if (ppg.length !== 1 || history.length !== 1) throw new Error('Health Net PPG Information or Eligibility History section is missing or ambiguous.');
    const [withinSection] = [(element: Element, heading: Element) => {
      if (!(heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
      const next = headings[headings.indexOf(heading) + 1];
      return !next || Boolean(element.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING);
    }];
    const titles = Array.from(document.querySelectorAll('h4.title')).filter(visible);
    const [readTitle] = [(matches: Element[], field: string) => {
      if (matches.length === 0) return '';
      if (matches.length !== 1) throw new Error(`Health Net ${field} is ambiguous.`);
      // Labels can be inside a wrapper with the value in the next column.
      let anchor: Element = matches[0];
      for (let depth = 0; depth < 3; depth++) {
      const parts: string[] = [];
      for (let node = anchor.nextSibling; node; node = node.nextSibling) {
        if (node instanceof Element && (node.matches('h3, h4.title') || node.querySelector('h3, h4.title'))) break;
        if (node instanceof Element && !visible(node)) continue;
        // textContent includes hidden duplicate IDs and tooltip text. Read
        // rendered text, retaining text-node values used by older layouts.
        const value = (node instanceof HTMLElement ? node.innerText : node.textContent)?.replace(/\s+/g, ' ').trim();
        if (field === 'Member' && /^[\s:#-]*$/.test(value || '')) continue;
        if (value) {
          parts.push(value);
          // Member identity is one value, not all following metadata in the row.
          if (field === 'Member') break;
        }
      }
      if (parts.length) return parts.join(' ');
      const parent = anchor.parentElement;
      if (!parent || clean(parent) !== clean(matches[0])) break;
      anchor = parent;
      }
      return '';
    }];
    const member = readTitle(titles.filter(el => /^(member\s*(#|id|number)|member)\s*:?$/i.test(clean(el))), 'Member');
    if (!member) throw new Error('Health Net result Member is missing.');
    // Provider/PCP sections also contain Name. Never treat all non-PPG
    // names as patient names, or discard eligibility over this optional field.
    const patientSections = headings.filter(el => /^patient information$/i.test(clean(el)));
    const patientNames = patientSections.length === 1
      ? titles.filter(el => clean(el) === 'Name' && withinSection(el, patientSections[0])) : [];
    const patientName = patientNames.length === 1 ? readTitle(patientNames, 'patient Name') : '';
    const addressTitles = patientSections.length === 1
      ? titles.filter(el => clean(el) === 'Address' && withinSection(el, patientSections[0])) : [];
    const address = addressTitles.length === 1 ? readTitle(addressTitles, 'Address') : '';
    const planName = readTitle(titles.filter(el => clean(el) === 'Name' && withinSection(el, ppg[0])), 'PPG Name');
    const ppgHistoryTable = Array.from(document.querySelectorAll('table')).filter(visible)
      .map(table => {
        const headerRow = table.querySelector('thead tr') ?? table.querySelector('tr');
        const headers = Array.from(headerRow?.children || []).map(cell => clean(cell).replace(/\s/g, '').toLowerCase());
        const name = headers.findIndex(header => header === 'name');
        const start = headers.findIndex(header => header === 'startdate');
        const end = headers.findIndex(header => header === 'enddate');
        return { table, headerRow, name, start, end };
      })
      .find(candidate => candidate.name >= 0 && candidate.start >= 0 && candidate.end >= 0);
    const ppgHistory = ppgHistoryTable
      ? Array.from(ppgHistoryTable.table.querySelectorAll('tr'))
        .filter(row => row !== ppgHistoryTable.headerRow && !row.closest('thead') && row.closest('table') === ppgHistoryTable.table && visible(row))
        .map(row => Array.from(row.children).filter(cell => /^(TD|TH)$/.test(cell.tagName)).map(cell => (cell as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))
        .find(cells => cells.length > Math.max(ppgHistoryTable.name, ppgHistoryTable.start, ppgHistoryTable.end))
      : undefined;
    const tables = Array.from(document.querySelectorAll('table')).filter(visible)
      .filter(el => withinSection(el, history[0]) && el.querySelector('#elig_hist_productname'));
    if (tables.length !== 1) throw new Error('Health Net Eligibility History table is missing or ambiguous.');
    const table = tables[0];
    const headerRow = table.querySelector('#elig_hist_productname')?.closest('tr');
    const headers = Array.from(headerRow?.children || []);
    const start = headers.findIndex(el => clean(el).replace(/\s/g, '').toLowerCase() === 'startdate');
    const end = headers.findIndex(el => clean(el).replace(/\s/g, '').toLowerCase() === 'enddate');
    const product = headers.findIndex(el => el.id === 'elig_hist_productname');
    if ([start, end, product].some(index => index < 0)) throw new Error('Health Net eligibility history columns are incomplete.');
    const rows = Array.from(table.querySelectorAll('tr')).filter(el => el !== headerRow && !el.closest('thead') && el.closest('table') === table && visible(el))
      // Keep row-header cells so their positions still align with the columns.
      .map(el => Array.from(el.children).filter(cell => /^(TD|TH)$/.test(cell.tagName)).map(cell => (cell as HTMLElement).innerText.replace(/\s+/g, ' ').trim()))
      .filter(cells => cells.length > Math.max(start, end, product));
    return {
      status,
      member,
      patientName,
      address,
      planName,
      ppgHistory: ppgHistory ? {
        name: ppgHistory[ppgHistoryTable!.name],
        start: ppgHistory[ppgHistoryTable!.start],
        end: ppgHistory[ppgHistoryTable!.end],
      } : undefined,
      history: rows.map(cells => ({ start: cells[start], end: cells[end], product: cells[product] })),
    };
  });
  const coverageStatus = /\b(not eligible|ineligible)\b/i.test(data.status) ? 'inactive'
    : /\bis eligible\b/i.test(data.status) ? 'active' : 'unknown';
  return { rowIndex, payerId: 'healthnet', coverageStatus, planStatus: data.status,
    memberId: data.member, patientName: data.patientName, address: data.address, planName: data.planName,
    effectiveDate: data.history.map(row => row.start || '-').join(' | '),
    terminationDate: data.history.map(row => row.end || '-').join(' | '),
    planType: data.history.map(row => row.product || '-').join(' | '),
    benefits: [], metadata: {
      healthnetEligibilityHistory: data.history,
      ...(data.ppgHistory ? {
        healthnetPpgName: data.ppgHistory.name,
        healthnetPpgStartDate: data.ppgHistory.start,
        healthnetPpgEndDate: data.ppgHistory.end,
      } : {}),
    } };
}

async function openHealthNetPpgHistory(page: Page, report: (message: string) => Promise<void>) {
  const button = page.locator(selectors.viewPpgHistory).filter({ visible: true });
  if (!await button.count().catch(() => 0)) return;
  if (await button.count() !== 1) throw new Error('Health Net View PPG History is ambiguous.');
  await report('Opening Health Net View PPG History.');
  await button.scrollIntoViewIfNeeded();
  await button.evaluate((element) => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  });
  await page.waitForFunction(() => {
    const clean = (el: Element) => el.textContent?.replace(/\s+/g, ' ').trim() || '';
    const visible = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    return Array.from(document.querySelectorAll('table')).filter(visible).some(table => {
      const headerRow = table.querySelector('thead tr') ?? table.querySelector('tr');
      const headers = Array.from(headerRow?.children || []).map(cell => clean(cell).replace(/\s/g, '').toLowerCase());
      return headers.includes('name') && headers.includes('startdate') && headers.includes('enddate');
    });
  }, undefined, { timeout: 15_000 }).catch(async () => {
    await report('Health Net View PPG History was clicked, but no readable PPG history row appeared. Output PPG history fields remain blank.');
  });
}

export async function verifyHealthNetRow(page: Page, inquiryUrl: string, row: EligibilityInputRow, report: (message: string) => Promise<void> = async () => {}) {
  if (!row.memberId || !row.dateOfBirth) throw new Error('Health Net requires Member ID and DOB.');
  const dob = normalizeWaystarDate(row.dateOfBirth);
  // Clear the previous member response before each new inquiry.
  await page.goto(inquiryUrl, { waitUntil: 'domcontentloaded' });
  // A saved flow URL can redirect back home. Its embedded member field does
  // not establish that the Eligibility navigation has been opened.
  if (isHealthNetDashboard(page)) {
    await report('Opening Health Net Eligibility from the dashboard before entering the member.');
    const exact = page.locator(selectors.eligibility).filter({ visible: true });
    const navigation = await exact.count() ? exact : page.getByRole('link', { name: /^Eligibility$/i })
      .or(page.getByRole('button', { name: /^Eligibility$/i })).filter({ visible: true });
    await navigation.click();
  }
  await report('Entering DOS, Member ID and DOB in the Health Net eligibility form.');
  await fillHealthNetMember(page, row.memberId, dob, row.dateOfService);
  if (await page.locator(`${selectors.alert}:visible`).filter({ hasText: /patient.*eligib/i }).count()) throw new Error('Health Net inquiry contains a previous patient result before search.');
  await report('Member ID and DOB entered. Checking Health Net eligibility.');
  // Submit inputs expose their value as the accessible name, not textContent.
  await page.locator(selectors.search).and(page.getByRole('button', { name: /^\s*Check Eligibility\s*$/i })).filter({ visible: true }).click();
  const details = page.locator(selectors.viewDetails).filter({ hasText: /^\s*View details\s*$/i }).filter({ visible: true });
  const product = page.locator(selectors.product).filter({ visible: true });
  // Some responses show a summary first; others already have details expanded.
  await details.or(product).first().waitFor({ state: 'visible', timeout: 60_000 });
  if (!await product.isVisible()) {
    if (await details.count() !== 1) throw new Error('Health Net View details is missing or ambiguous.');
    await report('Opening Health Net View details for PPG Information and Eligibility History.');
    await details.scrollIntoViewIfNeeded();
    await details.click();
  }
  await page.locator(`${selectors.alert}:visible`).filter({ hasText: /patient.*eligib/i }).waitFor({ state: 'visible', timeout: 60_000 });
  for (const section of ['PPG Information', 'Eligibility History']) {
    await report(`Overview loaded. Locating ${section}.`);
    const heading = page.getByRole('heading', { name: section, exact: true });
    try {
      await heading.waitFor({ state: 'visible', timeout: 30_000 });
      await heading.scrollIntoViewIfNeeded();
    } catch {
      throw new Error(`Health Net Overview opened, but ${section} was not visible. Unable to extract this section.`);
    }
  }
  await product.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {
    throw new Error('Health Net Eligibility History opened, but its Product Name column was not visible.');
  });
  await openHealthNetPpgHistory(page, report);
  await report('Reading PPG Name, member identity and Eligibility History dates/product.');
  const historyDeadline = Date.now() + 15_000;
  let result = await extractHealthNetResult(page, row.originalIndex);
  while (!(result.metadata?.healthnetEligibilityHistory as unknown[])?.length && Date.now() < historyDeadline) {
    await page.waitForTimeout(250);
    result = await extractHealthNetResult(page, row.originalIndex);
  }
  if (!(result.metadata?.healthnetEligibilityHistory as unknown[])?.length) await report('Eligibility History has no readable rows after waiting. Preserving coverage, Member and PPG Name; history output fields remain blank.');
  if (!healthNetMemberIdsMatch(result.memberId || '', row.memberId)) throw new HealthNetMemberMismatchError(row.memberId, result.memberId || '');
  return result;
}
