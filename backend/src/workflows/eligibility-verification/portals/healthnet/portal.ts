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
  search: 'button[name="submit"][type="submit"]',
  alert: 'div.alert.big', title: 'h4.title', product: '#elig_hist_productname',
};

export const HEALTHNET_LOGIN_WAIT_MS = 180_000;

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

export async function loginHealthNet(page: Page, credentials: { username: string; password: string; loginUrl: string }, context: AutomationContext) {
  await page.goto(credentials.loginUrl, { waitUntil: 'domcontentloaded', timeout: HEALTHNET_LOGIN_WAIT_MS });
  await page.locator(selectors.username).fill('');
  await page.locator(selectors.username).pressSequentially(credentials.username, { delay: 40 });
  await page.locator(selectors.username).press('Tab');
  if (await page.locator(selectors.username).inputValue() !== credentials.username) throw new Error('Health Net did not retain the username before submission.');
  await page.locator(selectors.next).click({ timeout: HEALTHNET_LOGIN_WAIT_MS });
  await waitForHealthNetLoginScreen(page, page.locator(selectors.password), context, 'password screen');
  await page.locator(selectors.password).fill('');
  await page.locator(selectors.password).pressSequentially(credentials.password, { delay: 40 });
  await page.locator(selectors.password).press('Tab');
  if (await page.locator(selectors.password).inputValue() !== credentials.password) throw new Error('Health Net did not retain the password before submission.');
  await context.log({ level: 'info', message: 'Submitting Health Net login. Waiting for the authentication-method screen.', eventName: 'eligibility_healthnet_login_submitted' });
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
    .or(page.locator(selectors.member)).and(page.locator(':visible')).first();
  await waitForHealthNetLoginScreen(page, ready, context, 'manual sign-in: complete login in the bot browser', timeoutMs, false);
  if (await page.locator(selectors.member).isVisible()) return page.url();
  return completeHealthNetAuthentication(page, context);
}

export async function completeHealthNetAuthentication(page: Page, context: AutomationContext) {
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
  await waitForHealthNetLoginScreen(page, page.locator(selectors.member), context, 'eligibility search screen');
  await page.locator(selectors.member).scrollIntoViewIfNeeded();
  return page.url();
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
      // Read only the value following this title within its own field container.
      const parts: string[] = [];
      for (let node = matches[0].nextSibling; node; node = node.nextSibling) {
        if (node instanceof Element && (node.matches('h3, h4.title') || node.querySelector('h3, h4.title'))) break;
        if (node instanceof Element && !visible(node)) continue;
        const value = node.textContent?.replace(/\s+/g, ' ').trim();
        if (value) parts.push(value);
      }
      return parts.join(' ');
    }];
    const member = readTitle(titles.filter(el => clean(el) === 'Member #'), 'Member');
    if (!member) throw new Error('Health Net result Member is missing.');
    const patientName = readTitle(titles.filter(el => clean(el) === 'Name' && !withinSection(el, ppg[0])), 'patient Name');
    const planName = readTitle(titles.filter(el => clean(el) === 'Name' && withinSection(el, ppg[0])), 'PPG Name');
    const tables = Array.from(document.querySelectorAll('table')).filter(visible)
      .filter(el => withinSection(el, history[0]) && el.querySelector('#elig_hist_productname'));
    if (tables.length !== 1) throw new Error('Health Net Eligibility History table is missing or ambiguous.');
    const table = tables[0];
    const headers = Array.from(table.querySelectorAll('th')).filter(el => el.closest('table') === table);
    const start = headers.findIndex(el => clean(el) === 'Start Date');
    const end = headers.findIndex(el => clean(el) === 'End Date');
    const product = headers.findIndex(el => el.id === 'elig_hist_productname');
    if ([start, end, product].some(index => index < 0)) throw new Error('Health Net eligibility history columns are incomplete.');
    const rows = Array.from(table.querySelectorAll('tr')).filter(el => el.closest('table') === table && visible(el))
      .map(el => Array.from(el.children).filter(cell => cell.tagName === 'TD').map(clean))
      .filter(cells => cells.length > Math.max(start, end, product));
    return { status, member, patientName, planName, history: rows.map(cells => ({ start: cells[start], end: cells[end], product: cells[product] })) };
  });
  const coverageStatus = /\b(not eligible|ineligible)\b/i.test(data.status) ? 'inactive'
    : /\bis eligible\b/i.test(data.status) ? 'active' : 'unknown';
  return { rowIndex, payerId: 'healthnet', coverageStatus, planStatus: data.status,
    memberId: data.member, patientName: data.patientName, planName: data.planName,
    effectiveDate: data.history.map(row => row.start || '-').join(' | '),
    terminationDate: data.history.map(row => row.end || '-').join(' | '),
    planType: data.history.map(row => row.product || '-').join(' | '),
    benefits: [], metadata: { healthnetEligibilityHistory: data.history } };
}

export async function verifyHealthNetRow(page: Page, inquiryUrl: string, row: EligibilityInputRow, report: (message: string) => Promise<void> = async () => {}) {
  if (!row.memberId || !row.dateOfBirth) throw new Error('Health Net requires Member ID and DOB.');
  const dob = normalizeWaystarDate(row.dateOfBirth);
  // Clear the previous member response before each new inquiry.
  await page.goto(inquiryUrl, { waitUntil: 'domcontentloaded' });
  const member = page.locator(selectors.member);
  await member.scrollIntoViewIfNeeded();
  await member.fill(row.memberId);
  await page.locator(selectors.dob).fill(dob);
  await page.locator(selectors.dob).press('Tab');
  if (await member.inputValue() !== row.memberId || normalizeWaystarDate(await page.locator(selectors.dob).inputValue()) !== dob) throw new Error('Health Net did not retain Member ID and DOB.');
  if (await page.locator(`${selectors.alert}:visible`).filter({ hasText: /patient.*eligib/i }).count()) throw new Error('Health Net inquiry contains a previous patient result before search.');
  await report('Member ID and DOB entered. Checking Health Net eligibility.');
  await page.locator(selectors.search).filter({ hasText: /^\s*Check Eligibility\s*$/ }).click();
  await page.locator(`${selectors.alert}:visible`).filter({ hasText: /patient.*eligib/i }).waitFor({ state: 'visible', timeout: 60_000 });
  await page.locator(selectors.product).waitFor({ state: 'visible', timeout: 30_000 });
  const result = await extractHealthNetResult(page, row.originalIndex);
  if (result.memberId?.replace(/\s+/g, '') !== row.memberId.replace(/\s+/g, '')) throw new Error('Health Net response Member does not match the requested Member ID.');
  return result;
}
