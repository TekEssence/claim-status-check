/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports, @typescript-eslint/no-unused-vars */
/**
 * lib/uhc-automation.ts
 *
 * Key changes vs original:
 * - Every step logs via sendEvent({ type: 'log', message }) immediately (no swallowed errors)
 * - Row errors logged as: log(`Row ${i+1}: Error — ${msg}`) + row_update with BotStatus=Error
 * - claimRows JSON passed from client (not re-read from file each batch)
 * - Robust login: tries multiple selector strategies, logs each attempt
 * - Screenshot + debug_html captured on every row failure
 */
// ── Enforce local browser path inside node_modules for server deployments ──
if (process.env.RENDER === 'true' || process.env.NETLIFY === 'true' || process.env.VERCEL === '1') {
  process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
}

import { chromium as playwrightChromium, firefox as playwrightFirefox, type Browser, type BrowserContext, type Page } from 'playwright-core';
import chromium from '@sparticuz/chromium';
import { linuxChromeUserAgent } from '@/backend/src/core/browser-fingerprint';
import type { ClaimRow, BotFields } from './excel';
import { generateTOTP, totpSecondsRemaining } from './totp';

// ── Exact selectors from LoginFlow.md HTML dumps ─────────────────────────────
const SEL = {
  // Step 1 — Sign In page (username only)
  // <input id="username" data-testid="username" type="text">
  // <button id="btnLogin">Continue</button>
  STEP1_USERNAME:   'input#username',
  STEP1_CONTINUE:   'button#btnLogin',

  // Step 2 — Password page
  // <input id="login-pwd" data-testid="login-pwd" type="password">
  // <button id="btnLogin">Continue</button>  (same ID, different page)

  STEP2_PASSWORD:   'input#login-pwd',
  STEP2_CONTINUE:   'button#btnLogin',

  //Step 3 - Minimax
  // Step 3a — Verify Identity (method selection)
  // <button id="totp">Via Microsoft Authenticator</button>
  STEP3_TOTP_BTN:   'button#totp',

  // Step 3b — Authenticator Code page
  // <input id="totp" data-testid="totp" maxlength="6">
  // <button id="btnVerify">Continue</button>
  STEP3_CODE_INPUT: 'input#totp',
  STEP3_VERIFY:     'button#btnVerify',

  //Step 3 - MedRevenu
  // Step 3a — Verify Identity (method selection)
  STEP3_TEXT_MSG_BTN: 'button#textMsg, button[data-cy="data-textMsg-field"], button:has-text("Via Text Message")',

  // Step 3b — Authenticator Code page
  STEP3_SMS_INPUT: 'input#otpBox',

  STEP3_SMS_CONTINUE: 'button#continuebtn',


  // Post-login: dashboard indicator
  CLAIMS_NAV: '[data-testid="claims-and-payments-link"]',

  // Claim search form selectors
  SEARCH_TYPE_BTN:  '[data-testid="claim-search-type-abyss-select-input-input"]',
  SEARCH_OPTION:    '[role="option"]:has-text("Member ID & date of birth")',
  TIN_RADIO:        'input[name="search.tinWideSearch"][value="tin"]',
  MEMBER_ID:        'input[name="search.claim.memberId"]',
  FIRST_NAME:       'input[name*="firstName" i], input[id*="firstName" i]',
  LAST_NAME:        'input[name*="lastName" i], input[id*="lastName" i]',
  DOB:              'input[name="search.claim.dateOfBirth"]',
  DATE_CUSTOM:      'input[name="search.dateRange"][value="custom"]',
  FIRST_SVC_DATE:   'input[name="search.dates.firstServiceDate"]',
  LAST_SVC_DATE:    'input[name="search.dates.lastServiceDate"]',
  SUBMIT_BTN:       '#submit-claim-search-button',
  SUBMIT_BTN_ALT:   '[aria-label="submit claim search"]',

  // Results
  RESULTS_HEADING:  '[data-testid="search-results-label"]',
  RESULTS_TBODY:    'tbody#claims-results',
  NEW_SEARCH_BTN:   '[data-testid="new-search-button-abyss-link-root"]',
  ALL_CLAIM_LINKS:  'a.abyss-link-root[href*="/summary/"], a[href*="/summary/"], a.abyss-link-root[href*="summary"]',
  NO_RESULTS:       '[data-testid="no-claims-found"]',

  // Error popup — appears after search when member found but no claim exists
  // <button data-testid="loading-close-button">x</button>
  // <div    data-testid="loading-error-message">Member found, but no claim...</div>
  POPUP_CLOSE:      'button[data-testid="loading-close-button"]',
  POPUP_MESSAGE:    'div[data-testid="loading-error-message"]',
};

const CLAIMS_URL = 'https://secure.uhcprovider.com/#/claims';
const OPERATION_SETTLE_MS = 2_000;
const CLAIM_RESULT_SECTION_SEPARATOR = '\n\n\n\n';

async function waitAfterOperation(page: Page, log: (msg: string) => Promise<void>, label: string) {
  await log(`  Waiting 2s after ${label}...`);
  await page.waitForTimeout(OPERATION_SETTLE_MS);
}

export interface SseEvent {
  type: 'log' | 'progress' | 'row_update' | 'error_screenshot' | 'debug_html' | 'done' | 'error' | 'padding' | 'provider_options' | 'otp_required';
  message?: string;
  completed?: number;
  total?: number;
  index?: number;    // 0-based index into claimRows array (for workbook update)
  rowIndex?: number; // 1-based Excel row number
  attempt?: number;  // Chunk execution attempt number
  update?: BotFields;
  image?: string;
  html?: string;
  requestId?: string;
  providerStage?: 'corporate' | 'care';
  corporateTaxIdOwners?: string[];
  careProviders?: string[];
}

export type SendEvent = (event: SseEvent) => Promise<void>;

export interface ProviderOptions {
  corporateTaxIdOwners: string[];
  careProviders: string[];
}

export type ProviderSelection = {
  corporateTaxIdOwner?: string;
  careProvider?: string;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

class UhcSessionRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UhcSessionRecoveryError';
  }
}

class UhcRowRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UhcRowRetryableError';
  }
}

function isUhcSessionRecoveryError(error: unknown): error is UhcSessionRecoveryError {
  return error instanceof UhcSessionRecoveryError || (error instanceof Error && error.name === 'UhcSessionRecoveryError');
}

function isUhcRowRetryableError(error: unknown): error is UhcRowRetryableError {
  return error instanceof UhcRowRetryableError || (error instanceof Error && error.name === 'UhcRowRetryableError');
}

function isSystemUnableToRespondText(value: string): boolean {
  const text = value.toLowerCase().replace(/\s+/g, ' ');
  return text.includes('the system is unable to respond at the moment') ||
    (text.includes('please try refreshing the page') && text.includes('try again at a later time'));
}

function isMemberLookupNotFoundMessage(value: string): boolean {
  const text = value.toLowerCase().replace(/\s+/g, ' ');
  return text.includes('member not found') ||
    text.includes('member id not found') ||
    text.includes('member id cannot be found') ||
    text.includes('member cannot be found') ||
    text.includes('check the data entered') ||
    text.includes('check your entries');
}

async function getSystemUnableToRespondMessage(page: Page): Promise<string | null> {
  const bodyText = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  if (!isSystemUnableToRespondText(bodyText)) return null;
  const match = bodyText.match(/The system is unable to respond at the moment\.[\s\S]*?(?:later time\.|$)/i);
  return (match?.[0] || 'The system is unable to respond at the moment.').replace(/\s+/g, ' ').trim();
}

async function isUhcHomePage(page: Page): Promise<boolean> {
  const bodyText = await page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
  const text = bodyText.toLowerCase().replace(/\s+/g, ' ');
  return text.includes('welcome,') &&
    text.includes('action required') &&
    text.includes('claims & payments') &&
    !text.includes('claim status search');
}

async function throwRetryIfHomePage(page: Page, context: string) {
  if (await isUhcHomePage(page)) {
    throw new UhcRowRetryableError(`UHC returned to the home page during ${context}. Retrying the claim search.`);
  }
}

function decodeClaimPayload(href: string): Record<string, string> {
  try {
    const b64 = href.replace(/^.*\/summary\//, '');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (err) {
    return {};
  }
}

function isServiceCode(value: string): boolean {
  const cleaned = value.trim().toUpperCase();
  return /^\d{5}$/.test(cleaned) || /^[A-Z]\d{4}$/.test(cleaned);
}

function getClaimServiceCode(claim: ClaimRow): string {
  const preferredKeys = [
    'Service Code',
    'Service code',
    'CPT',
    'CPT Code',
    'Procedure Code',
    'Procedure',
    'Proc Code',
    'HCPCS',
  ];

  for (const key of preferredKeys) {
    const value = String(claim[key] ?? '').trim();
    if (isServiceCode(value)) return value.toUpperCase();
  }

  for (const [key, rawValue] of Object.entries(claim)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!/(servicecode|cpt|procedure|proccode|hcpcs)/.test(normalizedKey)) continue;
    const value = String(rawValue ?? '').trim();
    if (isServiceCode(value)) return value.toUpperCase();
  }

  return '';
}

function formatServiceLinePrefix(cptCode: string | undefined, excludedCodes: string[] = []): string {
  const cleaned = (cptCode || '').trim();
  const isExcluded = excludedCodes.some(code => code.trim() && code.trim().toUpperCase() === cleaned.toUpperCase());
  return !isExcluded && isServiceCode(cleaned) ? `CPT ${cleaned}` : 'Service line';
}

function parseMoney(value: string | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  const isAccountingNegative = /^\(?\s*\$\s*\(?\s*[0-9,]+(?:\.\d{2})?\s*\)?\s*\)?$/.test(trimmed) && trimmed.includes('(') && trimmed.includes(')');
  const isLeadingNegative = /^-/.test(trimmed);
  const amount = parseFloat(trimmed.replace(/[^0-9.]/g, '')) || 0;
  return isAccountingNegative || isLeadingNegative ? -amount : amount;
}

function parseDateTimestamp(value: string | undefined): number {
  if (!value) return 0;
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return 0;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  return Date.UTC(year, month - 1, day);
}

function getDateTextVariants(value: string): string[] {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return [value.trim()];
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = match[3];
  return Array.from(new Set([
    `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`,
    `${month}/${day}/${year}`,
  ]));
}

function textContainsDate(value: string, targetDate: string): boolean {
  return getDateTextVariants(targetDate).some(variant => value.includes(variant));
}

async function getResultRowTextFromLink(link: import('playwright-core').Locator): Promise<string> {
  return link.locator('xpath=ancestor::tr[1]').innerText({ timeout: 1_000 }).catch(() => '');
}

async function getResultProcessedDateFromLink(link: import('playwright-core').Locator): Promise<string> {
  const row = link.locator('xpath=ancestor::tr[1]');
  const firstCell = await row.locator('td').first().innerText({ timeout: 500 }).catch(() => '');
  return firstCell.trim();
}

async function getResultRowClickables(page: Page): Promise<import('playwright-core').Locator[]> {
  const links = await page.locator(SEL.ALL_CLAIM_LINKS).all();
  if (links.length > 0) return links;

  const rows = page.locator(`${SEL.RESULTS_TBODY} tr`);
  const rowCount = await rows.count().catch(() => 0);
  const clickables: import('playwright-core').Locator[] = [];
  for (let i = 0; i < rowCount; i++) {
    const row = rows.nth(i);
    const candidate = row.locator('a, button, [role="link"]').first();
    if (await candidate.count().catch(() => 0) > 0) {
      clickables.push(candidate);
    }
  }
  return clickables;
}

function hasSummaryHref(href: string): boolean {
  return /\/summary\//i.test(href) || /summary/i.test(href);
}

async function getResultRowCellTexts(clickable: import('playwright-core').Locator): Promise<string[]> {
  const row = clickable.locator('xpath=ancestor::tr[1]');
  return row.locator('[role="cell"], td').evaluateAll(cells =>
    cells.map(cell => (cell.textContent || '').replace(/\s+/g, ' ').trim())
  ).catch(() => []);
}

async function getClaimNumberTooltipNote(page: Page, clickable: import('playwright-core').Locator): Promise<string> {
  const row = clickable.locator('xpath=ancestor::tr[1]');
  const claimNumberTrigger = row.locator('.abyss-table-cell-col-4-row-1 .abyss-tooltip-trigger, [data-dtrum-mask="true"].abyss-tooltip-trigger, [data-dtrum-mask="true"]').first();
  if (await claimNumberTrigger.count().catch(() => 0) === 0) return '';

  await claimNumberTrigger.hover({ timeout: 2_000 }).catch(() => {});
  await page.waitForTimeout(500);

  const tooltipTexts = await page.locator('[role="tooltip"], .abyss-tooltip, .abyss-tooltip-content, [data-radix-popper-content-wrapper], [data-state="delayed-open"]').evaluateAll(elements =>
    elements
      .map(element => (element.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
  ).catch(() => []);

  const rowText = await row.innerText({ timeout: 500 }).catch(() => '');
  const note = tooltipTexts.find(text => text && !rowText.includes(text) && text.length > 3) || '';
  return note.replace(/^Note:\s*/i, '').trim();
}

async function buildInProgressFieldsFromResultRow(
  page: Page,
  clickable: import('playwright-core').Locator,
  claim: ClaimRow,
  fallbackProcessedDate: string,
): Promise<Partial<BotFields>> {
  const cells = await getResultRowCellTexts(clickable);
  const tooltipNote = await getClaimNumberTooltipNote(page, clickable);
  const processedDate = firstNonEmpty(cells[1], fallbackProcessedDate, 'N/A');
  const claimNumber = firstNonEmpty(cells[3], 'N/A');
  const serviceDate = firstNonEmpty(cells[4], claim.serviceDate);
  const billedAmount = firstNonEmpty(cells[5], '');
  const paidAmount = firstNonEmpty(cells[6], '$0.00');
  const memberId = firstNonEmpty(cells[7], claim.subscriberNo);
  const patientAccount = firstNonEmpty(cells[8], '');
  const statusText = firstNonEmpty(cells[9], 'Action required');
  const claimDetails = [
    `Processed date: ${processedDate}`,
    `Claim number: ${claimNumber}`,
    `First service date: ${serviceDate}`,
    billedAmount ? `Billed amount: ${billedAmount}` : '',
    paidAmount ? `Paid amount: ${paidAmount}` : '',
    memberId ? `Member ID: ${memberId}` : '',
    patientAccount ? `Patient account number: ${patientAccount}` : '',
    `Portal status: ${statusText}`,
    tooltipNote ? `Note: ${tooltipNote}` : '',
  ].filter(Boolean).join('\n');
  const noteText = tooltipNote ? ` Note: ${tooltipNote}` : '';

  return {
    BotClaimNumber: claimNumber,
    BotClaimStatus: 'In Progress',
    BotPaidAmount: paidAmount,
    BotBilledAmount: billedAmount,
    BotProcessedDate: processedDate,
    BotClaimDetails: claimDetails,
    BotClaimResult: `DOS ${serviceDate} Claim processed on ${processedDate} is in progress by UHC on Claim # ${claimNumber}.${noteText}`,
  };
}

function formatMoney(value: string | undefined): string {
  const amount = parseMoney(value);
  const absoluteAmount = Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return amount < 0 ? `-$${absoluteAmount}` : `$${absoluteAmount}`;
}

function cleanPayerName(value: string | undefined): string {
  const cleaned = (value || 'UnitedHealthcare')
    .replace(/keyboard_arrow_\w+/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  return /^united\s*healthcare$/i.test(cleaned) || /^uhc$/i.test(cleaned) ? 'UHC' : cleaned;
}

function formatCodeText(value: string): string {
  return value.trim().replace(/^([A-Z0-9]+)\s*:\s*/i, '$1 - ').replace(/[.\s]+$/, '');
}

function formatCodesByCpt(lineItems: any[], codeKey: 'carcs' | 'remarks'): string {
  const codesByCpt = new Map<string, Set<string>>();

  lineItems.forEach(item => {
    const cpt = item.cptCode || 'N/A';
    const codes = Array.isArray(item[codeKey]) ? item[codeKey].filter(Boolean).map(formatCodeText) : [];
    if (codes.length === 0) return;

    if (!codesByCpt.has(cpt)) {
      codesByCpt.set(cpt, new Set());
    }
    codes.forEach(code => codesByCpt.get(cpt)?.add(code));
  });

  return Array.from(codesByCpt.entries())
    .map(([cpt, codes]) => `CPT: ${cpt} -> ${Array.from(codes).join('; ')}`)
    .join('; ');
}

function formatDenialReason(codes: string[]): string {
  const uniqueCodes = Array.from(new Set(codes.map(formatCodeText).filter(Boolean)));
  if (uniqueCodes.length === 0) return 'Service denied';
  if (uniqueCodes.length === 1) return uniqueCodes[0];
  if (uniqueCodes.length === 2) return `${uniqueCodes[0]} and ${uniqueCodes[1]}`;
  return `${uniqueCodes.slice(0, -1).join('; ')}; and ${uniqueCodes[uniqueCodes.length - 1]}`;
}

function buildServiceLineNotes(lineItems: any[], excludedCodes: string[], includePaidResponsibility = true): string[] {
  const grouped = new Map<string, { cptCode: string; paidItem?: any; denialCodes: string[] }>();

  lineItems.forEach(item => {
    const cptCode = item.cptCode || '';
    const key = cptCode || `line-${grouped.size + 1}`;
    if (!grouped.has(key)) {
      grouped.set(key, { cptCode, denialCodes: [] });
    }

    const group = grouped.get(key)!;
    const itemPaidVal = parseMoney(item.paidAmount);
    if (itemPaidVal > 0) {
      if (!group.paidItem || itemPaidVal > parseMoney(group.paidItem.paidAmount)) {
        group.paidItem = item;
      }
      return;
    }

    const denialCodes = Array.isArray(item.carcs) && item.carcs.length > 0
      ? item.carcs
      : item.denialReason
        ? [item.denialReason]
        : [];
    group.denialCodes.push(...denialCodes);
  });

  return Array.from(grouped.values()).map(group => {
    const linePrefix = formatServiceLinePrefix(group.cptCode, excludedCodes);
    if (group.paidItem) {
      const responsibility = includePaidResponsibility
        ? formatPatientResponsibility(group.paidItem.patientResponsibility, group.paidItem.patientResponsibilityCategories || [])
        : '';
      const responsibilityText = responsibility ? `, ${responsibility}` : '';
      return `${linePrefix}: Allowed Amount ${group.paidItem.allowedAmount}, Paid Amount ${group.paidItem.paidAmount}${responsibilityText}.`;
    }

    return `${linePrefix}: Denied for ${formatDenialReason(group.denialCodes)}.`;
  });
}

function formatPatientResponsibility(amount: string | undefined, categories: string[]): string {
  const uniqueCategories = Array.from(new Set(categories));
  if (!amount || parseMoney(amount) <= 0 || uniqueCategories.length === 0) return '';

  if (uniqueCategories.length === 1) {
    return `${uniqueCategories[0]} ${formatMoney(amount)}`;
  }

  return `Patient Responsibility: ${formatMoney(amount)} (${uniqueCategories.join(', ')})`;
}

function formatClaimLevelPatientResponsibility(lineItems: any[], amount: string | undefined): string {
  const paidCategories = lineItems
    .filter(item => parseMoney(item.paidAmount) > 0)
    .flatMap(item => Array.isArray(item.patientResponsibilityCategories) ? item.patientResponsibilityCategories : []);

  return formatPatientResponsibility(amount, paidCategories);
}

function parsePaymentRows(value: string | undefined): Array<{ issueDate: string; number: string; amount: string }> {
  if (!value) return [];
  try {
    const rows = JSON.parse(value);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function uniqueJoin(values: Array<string | undefined>, fallback = 'N/A'): string {
  const uniqueValues = Array.from(new Set(values.map(value => (value || '').trim()).filter(Boolean)));
  return uniqueValues.length > 0 ? uniqueValues.join(', ') : fallback;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  return values.map(value => (value || '').trim()).find(Boolean) || '';
}

function uniqueSortedProcessedDates(dates: Array<string | undefined>): string[] {
  return Array.from(new Set(dates.map(value => (value || '').trim()).filter(Boolean)))
    .sort((left, right) => parseDateTimestamp(right) - parseDateTimestamp(left));
}

function groupLineItemsByProcessedDate(
  lineItems: any[],
  fallbackProcessedDate: string,
): Array<{ processedDate: string; lineItems: any[] }> {
  if (lineItems.length === 0) {
    return [{ processedDate: fallbackProcessedDate || 'N/A', lineItems: [] }];
  }

  const groups = new Map<string, any[]>();
  for (const item of lineItems) {
    const processedDate = String(item?.processedDate || fallbackProcessedDate || 'N/A').trim();
    groups.set(processedDate, [...(groups.get(processedDate) ?? []), item]);
  }

  return Array.from(groups.entries())
    .sort(([left], [right]) => parseDateTimestamp(right) - parseDateTimestamp(left))
    .map(([processedDate, groupedLineItems]) => ({ processedDate, lineItems: groupedLineItems }));
}

function checkDateForProcessedDate(
  processedDate: string,
  availableProcessedDates: string[],
  paymentRows: Array<{ issueDate: string }>,
  fallback: string,
): string {
  const sortedProcessedDates = uniqueSortedProcessedDates(availableProcessedDates);
  const sortedCheckDates = uniqueSortedProcessedDates(paymentRows.map(row => row.issueDate));
  if (sortedProcessedDates.length > 1 && sortedCheckDates.length > 1) {
    const processedTimestamp = parseDateTimestamp(processedDate);
    const processedIndex = sortedProcessedDates.findIndex(date => parseDateTimestamp(date) === processedTimestamp);
    if (processedIndex >= 0 && sortedCheckDates[processedIndex]) {
      return sortedCheckDates[processedIndex];
    }
  }
  return fallback;
}

function paymentRowsForProcessedDate<T extends { issueDate: string }>(
  processedDate: string,
  availableProcessedDates: string[],
  paymentRows: T[],
): T[] {
  const sortedProcessedDates = uniqueSortedProcessedDates(availableProcessedDates);
  const sortedPaymentRows = [...paymentRows]
    .filter(row => (row.issueDate || '').trim())
    .sort((left, right) => parseDateTimestamp(right.issueDate) - parseDateTimestamp(left.issueDate));
  if (sortedProcessedDates.length > 1 && sortedPaymentRows.length > 1) {
    const processedTimestamp = parseDateTimestamp(processedDate);
    const processedIndex = sortedProcessedDates.findIndex(date => parseDateTimestamp(date) === processedTimestamp);
    if (processedIndex >= 0 && sortedPaymentRows[processedIndex]) {
      return [sortedPaymentRows[processedIndex]];
    }
  }
  return paymentRows;
}

function paymentDetailsSignature(paymentRows: Array<{ number: string; amount: string }>): string {
  return paymentRows
    .map(row => {
      const number = (row.number || '').replace(/\s+/g, '').toUpperCase();
      const amount = formatMoney(row.amount || '$0.00');
      return number && amount ? `${number}|${amount}` : '';
    })
    .filter(Boolean)
    .sort()
    .join('||');
}

function paymentDetailsMatch(leftData: Record<string, string>, rightData: Record<string, string>): boolean {
  const leftSignature = paymentDetailsSignature(parsePaymentRows(leftData['payment-rows-json']));
  const rightSignature = paymentDetailsSignature(parsePaymentRows(rightData['payment-rows-json']));
  return Boolean(leftSignature && rightSignature && leftSignature === rightSignature);
}

function joinClaimResultSections(sections: string[]): string {
  return sections.map(section => section.trim()).filter(Boolean).join(CLAIM_RESULT_SECTION_SEPARATOR);
}

function formatCheckAmounts(paymentRows: Array<{ amount: string }>, fallbackAmount: string, linePaidTotal: number): string {
  const rows = paymentRows.length > 0 ? paymentRows : [{ amount: fallbackAmount }];
  return rows
    .map(row => {
      const amount = row.amount || fallbackAmount;
      const bulkStatus = linePaidTotal > parseMoney(amount) ? 'Not Bulk' : 'Bulk';
      return `${formatMoney(amount)} (${bulkStatus})`;
    })
    .join(' + ');
}

function normalizeOptionText(value: string | undefined): string {
  return (value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function compactProviderOptionText(value: string | undefined): string {
  return normalizeOptionText(value).replace(/[^a-z0-9]/g, '');
}

function extractProviderOptionId(value: string | undefined): string {
  const match = (value || '').match(/\d{4,}/);
  return match?.[1] || '';
}

function formatMedRevenuDenialReason(lineItems: any[], fallback: string | undefined): string {
  const paidCptCodes = new Set(
    lineItems
      .filter(item => parseMoney(item.paidAmount) > 0)
      .map(item => item.cptCode)
      .filter(Boolean)
  );
  const codes = lineItems
    .filter(item => !paidCptCodes.has(item.cptCode))
    .flatMap(item => Array.isArray(item.carcs) ? item.carcs : [])
    .filter(Boolean);
  const reason = formatDenialReason(codes);
  return reason === 'Service denied' ? (fallback || reason) : reason;
}

function filterLineItemsByServiceCode(lineItems: any[], serviceCode: string): any[] {
  const normalizedServiceCode = serviceCode.trim().toUpperCase();
  if (!normalizedServiceCode) return lineItems;
  const matches = lineItems.filter(item => String(item.cptCode || '').trim().toUpperCase() === normalizedServiceCode);
  return matches.length > 0 ? matches : lineItems;
}

function hasLineAdjudicationDetails(lineItems: any[]): boolean {
  return lineItems.some(item => {
    const hasPaid = parseMoney(item.paidAmount) > 0;
    const hasCarcs = Array.isArray(item.carcs) && item.carcs.length > 0;
    const hasRemarks = Array.isArray(item.remarks) && item.remarks.length > 0;
    const hasRemits = Array.isArray(item.remits) && item.remits.length > 0;
    return hasPaid || hasCarcs || hasRemarks || hasRemits;
  });
}

async function expandProviderDrawerSection(page: Page, headingText: string, log: (msg: string) => Promise<void>) {
  const trigger = page.locator('button.abyss-accordion-trigger', { hasText: headingText }).first();
  await trigger.waitFor({ state: 'visible', timeout: 8_000 });
  const expanded = await trigger.getAttribute('aria-expanded');
  const state = await trigger.getAttribute('data-state');
  if (expanded !== 'true' && state !== 'open') {
    await log(`  Selecting provider drawer section: ${headingText}`);
    await trigger.click({ force: true });
    await waitAfterOperation(page, log, `provider drawer section ${headingText} click`);
  }
}

async function selectProviderDrawerRow(
  page: Page,
  testId: string,
  label: string,
  value: string,
  log: (msg: string) => Promise<void>
) {
  const wanted = normalizeOptionText(value);
  const compactWanted = compactProviderOptionText(value);
  const wantedId = extractProviderOptionId(value);
  if (!wanted) return;

  const rows = page.locator(`[data-testid="${testId}"]`);

  const trySelectVisibleRow = async () => {
    await rows.first().waitFor({ state: 'visible', timeout: 8_000 });
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const rawText = await row.textContent().catch(() => '');
      const text = normalizeOptionText(rawText || '');
      const compactText = compactProviderOptionText(rawText || '');
      const rowId = extractProviderOptionId(rawText || '');
      if (
        text === wanted ||
        text.includes(wanted) ||
        wanted.includes(text) ||
        compactText === compactWanted ||
        compactText.includes(compactWanted) ||
        compactWanted.includes(compactText) ||
        (!!wantedId && rowId === wantedId)
      ) {
        await log(`  Selecting ${label}: ${value}`);
        await row.click({ force: true });
        await waitAfterOperation(page, log, `${label} row selection`);
        return true;
      }
    }
    return false;
  };

  if (await trySelectVisibleRow()) return;

  const searchInputs = page.locator('[data-testid="provider-drawer-search-input-field-abyss-text-input"]');
  const visibleInputCount = await searchInputs.count();
  if (visibleInputCount > 0) {
    const searchInput = searchInputs.nth(visibleInputCount - 1);
    if (await searchInput.isVisible().catch(() => false)) {
      const searchText = value.replace(/\s*\(\d+\)\s*$/, '').trim() || value;
      await log(`  Filtering ${label} options: ${searchText}`);
      await searchInput.fill('');
      await searchInput.fill(searchText);
      await waitAfterOperation(page, log, `${label} filter input`);
      if (await trySelectVisibleRow()) return;
    }
  }

  const visibleOptions = await rows.evaluateAll(elements =>
    elements.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
  ).catch(() => []);
  await log(`  Visible ${label} options: ${visibleOptions.length ? visibleOptions.join(' | ') : 'none'}`);

  throw new Error(`${label} option not found in provider drawer: ${value}`);
}

async function closeProviderDrawerAfterSave(page: Page, log: (msg: string) => Promise<void>) {
  const saveButton = page.locator('[data-testid="provider-drawer-save-button-abyss-button-root"]');

  try {
    await saveButton.waitFor({ state: 'hidden', timeout: 5_000 });
    return;
  } catch {
    await log('  Provider drawer did not auto-close after Save. Closing it manually...');
  }

  await closeProviderDrawerNow(page, log);
}

async function closeProviderDrawerNow(page: Page, log: (msg: string) => Promise<void>) {
  const saveButton = page.locator('[data-testid="provider-drawer-save-button-abyss-button-root"]');
  const closeIcon = page.locator('[data-testid="provider-drawer-title-abyss-modal-close-icon-abyss-icon-symbol"]');

  if (await closeIcon.count() > 0 && await closeIcon.first().isVisible().catch(() => false)) {
    await closeIcon.first().click({ force: true });
    await waitAfterOperation(page, log, 'provider drawer close click');
  } else {
    await page.keyboard.press('Escape').catch(() => {});
    await waitAfterOperation(page, log, 'provider drawer Escape close');
  }

  await saveButton.waitFor({ state: 'hidden', timeout: 10_000 }).catch(async () => {
    await log('  Provider drawer close was not confirmed within 10s. Continuing.');
  });
}

async function saveProviderDrawerIfChanged(page: Page, log: (msg: string) => Promise<void>): Promise<boolean> {
  const saveButton = page.locator('[data-testid="provider-drawer-save-button-abyss-button-root"]');
  await saveButton.waitFor({ state: 'visible', timeout: 8_000 });

  const ariaDisabled = await saveButton.getAttribute('aria-disabled').catch(() => null);
  const isEnabled = await saveButton.isEnabled().catch(() => false);
  if (ariaDisabled === 'true' || !isEnabled) {
    await log('  Provider drawer Save is disabled, so the selected value is already active.');
    await closeProviderDrawerNow(page, log);
    return false;
  }

  await saveButton.click({ timeout: 8_000 });
  await waitAfterOperation(page, log, 'provider drawer Save click');
  await closeProviderDrawerAfterSave(page, log);
  return true;
}

async function configureProviderSelection(
  page: Page,
  options: { corporateTaxIdOwner?: string; careProvider?: string },
  log: (msg: string) => Promise<void>
) {
  const corporateTaxIdOwner = (options.corporateTaxIdOwner || '').trim();
  const careProvider = (options.careProvider || '').trim();
  if (!corporateTaxIdOwner && !careProvider) {
    return;
  }

  await log('Opening provider selector drawer...');
  await page.locator('[data-testid="provider-select-drawer-button-abyss-button-root"]').click({ timeout: 10_000 });
  await waitAfterOperation(page, log, 'provider selector drawer click');
  await page.locator('[data-testid="provider-drawer-save-button-abyss-button-root"]').waitFor({ state: 'visible', timeout: 10_000 });

  if (corporateTaxIdOwner) {
    await expandProviderDrawerSection(page, 'Corporate tax ID owner', log);
    await selectProviderDrawerRow(page, 'corporate-taxid-table-row', 'Corporate Tax ID owner', corporateTaxIdOwner, log);
  }

  if (careProvider) {
    await expandProviderDrawerSection(page, 'Care Provider', log);
    await selectProviderDrawerRow(page, 'care-provider-table-row', 'Care Provider', careProvider, log);
  }

  const didSave = await saveProviderDrawerIfChanged(page, log);
  await waitAfterOperation(page, log, 'provider selection save result');
  await log(didSave ? 'Provider selection saved.' : 'Provider selection already active.');
}

async function openProviderDrawer(page: Page, log: (msg: string) => Promise<void>, reason: string) {
  await log(`Opening provider selector drawer ${reason}...`);
  await page.locator('[data-testid="provider-select-drawer-button-abyss-button-root"]').click({ timeout: 10_000 });
  await waitAfterOperation(page, log, 'provider selector drawer click');
  await page.locator('[data-testid="provider-drawer-save-button-abyss-button-root"]').waitFor({ state: 'visible', timeout: 10_000 });
}

async function closeProviderDrawerWithoutChanges(page: Page, log: (msg: string) => Promise<void>) {
  await closeProviderDrawerNow(page, log);
  await waitAfterOperation(page, log, 'provider drawer close');
}

async function scrapeCorporateTaxIdOwners(page: Page, log: (msg: string) => Promise<void>): Promise<string[]> {
  await openProviderDrawer(page, log, 'to fetch Corporate Tax ID owner options');
  await expandProviderDrawerSection(page, 'Corporate tax ID owner', log);
  await page.locator('[data-testid="corporate-taxid-table-row"]').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
    await log('  Corporate Tax ID owner rows were not visible after expand.');
  });
  const corporateTaxIdOwners = await page.locator('[data-testid="corporate-taxid-table-row"]').evaluateAll(elements =>
    Array.from(new Set(elements.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)))
  );

  await closeProviderDrawerWithoutChanges(page, log);
  await log(`Fetched provider options: ${corporateTaxIdOwners.length} corporate owner(s).`);
  return corporateTaxIdOwners;
}

async function scrapeCareProviders(page: Page, log: (msg: string) => Promise<void>): Promise<string[]> {
  await openProviderDrawer(page, log, 'to fetch Care Provider options');
  const careProviders = await scrapeCareProvidersFromOpenDrawer(page, log);
  await closeProviderDrawerWithoutChanges(page, log);
  await log(`Fetched provider options: ${careProviders.length} care provider(s).`);
  return careProviders;
}

async function scrapeCareProvidersFromOpenDrawer(page: Page, log: (msg: string) => Promise<void>): Promise<string[]> {
  await expandProviderDrawerSection(page, 'Care Provider', log);
  await page.locator('[data-testid="care-provider-table-row"]').first().waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
    await log('  Care Provider rows were not visible after expand.');
  });
  return await page.locator('[data-testid="care-provider-table-row"]').evaluateAll(elements =>
    Array.from(new Set(elements.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)))
  );
}

async function selectCorporateAndFetchCareProviders(
  page: Page,
  corporateTaxIdOwner: string,
  log: (msg: string) => Promise<void>
): Promise<string[]> {
  await openProviderDrawer(page, log, 'to select Corporate Tax ID owner');
  await expandProviderDrawerSection(page, 'Corporate tax ID owner', log);
  await selectProviderDrawerRow(page, 'corporate-taxid-table-row', 'Corporate Tax ID owner', corporateTaxIdOwner, log);
  await page.waitForTimeout(1_000);
  const careProviders = await scrapeCareProvidersFromOpenDrawer(page, log);
  await log(`Fetched provider options after Corporate Tax ID owner selection: ${careProviders.length} care provider(s).`);
  return careProviders;
}

async function selectCareProviderAndSaveOpenDrawer(
  page: Page,
  careProvider: string,
  log: (msg: string) => Promise<void>
) {
  if (careProvider) {
    await expandProviderDrawerSection(page, 'Care Provider', log);
    await selectProviderDrawerRow(page, 'care-provider-table-row', 'Care Provider', careProvider, log);
  }
  const didSave = await saveProviderDrawerIfChanged(page, log);
  await page.waitForTimeout(1_000);
  await log(didSave ? 'Provider selection saved.' : 'Provider selection already active.');
}

async function scrapeProviderOptions(page: Page, log: (msg: string) => Promise<void>): Promise<ProviderOptions> {
  const corporateTaxIdOwners = await scrapeCorporateTaxIdOwners(page, log);
  const careProviders = await scrapeCareProviders(page, log);
  return { corporateTaxIdOwners, careProviders };
}

async function waitForSelectorInStages(
  page: Page,
  selector: string,
  options: {
    label: string;
    totalTimeoutMs: number;
    stageTimeoutMs?: number;
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
  },
  log: (msg: string) => Promise<void>
): Promise<boolean> {
  const stageTimeoutMs = options.stageTimeoutMs ?? 3_000;
  const state = options.state ?? 'visible';
  let elapsedMs = 0;

  while (elapsedMs < options.totalTimeoutMs) {
    const timeout = Math.min(stageTimeoutMs, options.totalTimeoutMs - elapsedMs);
    try {
      await page.waitForSelector(selector, { state, timeout });
      return true;
    } catch {
      elapsedMs += timeout;
      if (elapsedMs < options.totalTimeoutMs) {
        await log(`  ⏳  Still waiting for ${options.label} (${elapsedMs / 1000}s/${options.totalTimeoutMs / 1000}s)...`);
      }
    }
  }

  await log(`  ⚠️  Timeout waiting for ${options.label} after ${options.totalTimeoutMs / 1000}s.`);
  return false;
}

/** Try each selector in the list, return the first one that matches */
async function findFirst(page: Page, selectors: string[], timeout = 5000): Promise<string | null> {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout });
      return sel;
    } catch {
      // try next
    }
  }
  return null;
}

// ── Close claims & payments navigation menu if it is expanded and blocking the page ──
async function closeNavDropdownIfOpen(page: Page, log: (msg: string) => Promise<void>) {
  try {
    const trigger = page.locator('button:has([data-testid="claims-and-payments-link"])');
    if (await trigger.count() > 0) {
      const state = await trigger.getAttribute('data-state');
      const expanded = await trigger.getAttribute('aria-expanded');
      if (state === 'open' || expanded === 'true') {
        await log('  ⚠️  "Claims & Payments" dropdown menu is expanded/blocking. Clicking to close it...');
        await trigger.click({ force: true });
        try {
          await page.waitForFunction(
            (el) => el?.getAttribute('data-state') !== 'open' && el?.getAttribute('aria-expanded') !== 'true',
            await trigger.elementHandle(),
            { timeout: 3_000 }
          );
        } catch { /* ignore wait timeout */ }
        await page.waitForTimeout(500); // allow animations to settle
        await log('  ✖️  Dropdown menu closed.');
      }
    }
  } catch (err) {
    await log(`  ⚠️  Failed to check/close navigation dropdown: ${err}`);
  }
}

// ── Popup handler ─────────────────────────────────────────────────────────────
//
// After a search submit, UHC may show an error popup:
//   <button data-testid="loading-close-button">x</button>
//   <div    data-testid="loading-error-message">Member found, but no claim found...</div>
//
// Returns the popup message text if a popup was found and dismissed, null otherwise.
//
async function dismissPopupIfPresent(
  page: Page,
  sendEvent: SendEvent
): Promise<string | null> {
  const log = (msg: string) => sendEvent({ type: 'log', message: msg });
  try {
    await page.waitForSelector(SEL.POPUP_CLOSE, { timeout: 4_000 });
  } catch {
    return null; // no popup — happy path
  }

  // Read message before closing (DOM is gone after close)
  let message = '';
  try {
    const messageLocator = page.locator(SEL.POPUP_MESSAGE).first();
    const fullDialogText = await messageLocator
      .locator('xpath=ancestor::*[@role="dialog" or contains(@class, "modal") or contains(@class, "loading")][1]')
      .innerText({ timeout: 1_000 })
      .catch(() => '');
    message = (fullDialogText || await messageLocator.innerText({ timeout: 2_000 })).replace(/\s+/g, ' ').trim();
  } catch {
    message = 'An error popup appeared but its message could not be read.';
  }

  await log(`  ⚠️  Popup detected: "${message}"`);

  // Dismiss
  try {
    await page.click(SEL.POPUP_CLOSE, { force: true });
    await page.locator(SEL.POPUP_CLOSE).waitFor({ state: 'detached', timeout: 3_000 });
    // Also wait for the message element to detach
    try {
      await page.locator(SEL.POPUP_MESSAGE).waitFor({ state: 'detached', timeout: 2_000 });
    } catch { /* ignore if not detached or already gone */ }
    await page.waitForTimeout(500); // allow animations to settle
    await log('  ✖️  Popup closed.');
  } catch {
    await log('  ⚠️  Could not close popup — it may have already dismissed itself.');
  }

  return message;
}

// ── clickWithRetry ─────────────────────────────────────────────────────────────────
//
// Clicks a button and then checks that the page has moved on (i.e. the
// clicked element disappears OR a new element appears). If the page hasn't
// changed after `delayMs`, it clicks again. Retries up to `maxAttempts`.
//
async function clickWithRetry(
  page: Page,
  selector: string,
  {
    label         = selector,
    maxAttempts   = 3,
    retryDelayMs  = 2_000,
    disappearsSel = selector,   // selector we wait to disappear (confirms click worked)
    appearsSel,
  }: {
    label?:         string;
    maxAttempts?:   number;
    retryDelayMs?:  number;
    disappearsSel?: string;
    appearsSel?:    string;
  },
  log: (msg: string) => Promise<void>
): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const btn = page.locator(selector).first();
      await btn.waitFor({ state: 'visible', timeout: 5_000 });
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await btn.click({ timeout: 5_000 }).catch(async () => {
        await btn.click({ force: true, timeout: 5_000 }).catch(async () => {
          await btn.evaluate((element: HTMLElement) => element.click());
        });
      });
      await waitAfterOperation(page, log, `${label} click`);
      await log(`  🖱️  Clicked ${label} (attempt ${attempt}/${maxAttempts}).`);

      // Wait briefly to see if the page reacts (button disappears = success)
      try {
        if (appearsSel) {
          await page.locator(appearsSel).first().waitFor({ state: 'visible', timeout: retryDelayMs });
          await log(`  ✅  ${label} click confirmed (${appearsSel} appeared).`);
          return; // success
        }
        await page.locator(disappearsSel).waitFor({ state: 'detached', timeout: retryDelayMs });
        await log(`  ✔️  ${label} click confirmed (element detached).`);
        return; // success
      } catch {
        // element still present — might just be slow navigation; don't fail yet
        if (attempt < maxAttempts) {
          await log(`  ⏳  ${label} still visible after ${retryDelayMs}ms — retrying (${attempt}/${maxAttempts})...`);
        }
      }
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await log(`  ⚠️  ${label} click failed (attempt ${attempt}): ${err}. Retrying...`);
      await page.waitForTimeout(retryDelayMs);
    }
  }
  // Reached here = button clicked N times but never detached; let caller decide
  await log(`  ⚠️  ${label}: ${maxAttempts} click(s) sent; proceeding (page may be slow).`);
}

// ── Login — exact 3-step UHC / One Healthcare ID flow ───────────────────────
//
// Step 1: Sign In page  → input#username  → button#btnLogin ("Continue")
// Step 2: Password page → input#login-pwd → button#btnLogin ("Continue")
// Step 3a: Verify page  → button#totp     ("Via Microsoft Authenticator")
// Step 3b: TOTP page    → input#totp      → button#btnVerify ("Continue")
//
async function waitForLoginLanding(
  page: Page,
  log: (msg: string) => Promise<void>
): Promise<'dashboard' | 'sign-in' | null> {
  const detect = async (): Promise<'dashboard' | 'sign-in' | null> => {
    if (await page.locator(SEL.CLAIMS_NAV).first().isVisible().catch(() => false)) {
      return 'dashboard';
    }
    if (await page.locator(SEL.STEP1_USERNAME).first().isVisible().catch(() => false)) {
      return 'sign-in';
    }
    return null;
  };

  await log('  ⏳  Waiting 10s for UHC login/sign-in page to settle...');
  await page.waitForTimeout(10_000);

  let state = await detect();
  if (state) return state;

  let elapsedMs = 10_000;
  while (elapsedMs < 30_000) {
    const waitMs = Math.min(3_000, 30_000 - elapsedMs);
    await log(`  ⏳  Login page not detected yet (${elapsedMs / 1000}s/30s). Waiting another ${waitMs / 1000}s...`);
    await page.waitForTimeout(waitMs);
    elapsedMs += waitMs;

    state = await detect();
    if (state) return state;
  }

  return null;
}

async function login(
  page: Page,
  username: string,
  password: string,
  baseUrl: string,
  startRowIndex: number,
  attempt: number,
  clientType: string,
  requestOtp: (() => Promise<string>) | undefined,
  sendEvent: SendEvent
) {
  const log = (msg: string) => sendEvent({ type: 'log', message: msg });

  /** Capture screenshot + debug HTML then throw — used on every failure point */
  const failWithDiagnostics = async (reason: string): Promise<never> => {
    try {
      const ss   = await page.screenshot({ type: 'jpeg', quality: 60 });
      await sendEvent({ type: 'error_screenshot', index: -1, rowIndex: startRowIndex, attempt, image: ss.toString('base64') });
      await page.waitForTimeout(1000);
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      await sendEvent({ type: 'debug_html', index: -1, rowIndex: startRowIndex, attempt, html });
    } catch { /* ignore diagnostic errors */ }
    const err = new Error(reason);
    (err as any).diagnosticsCaptured = true;
    throw err;
  };

  // ── Navigate to the login URL ──────────────────────────────────────────────
  await log(`🔐 Navigating to ${baseUrl} ...`);
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const landingState = await waitForLoginLanding(page, log);

  // ── Already logged in? ─────────────────────────────────────────────────────
  if (landingState === null) {
    await failWithDiagnostics('Login failed: neither dashboard nor sign-in page appeared within 30s after navigation.');
  }

  if (landingState === 'sign-in') {
    await log('🔑 Not logged in. Starting 3-step authentication...');
  } else {
  try {
    await page.waitForSelector(SEL.CLAIMS_NAV, { timeout: 5_000 });
    await log('✅ Already logged in — session active, skipping auth.');
    return;
  } catch {
    await log('🔑 Not logged in. Starting 3-step authentication...');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 1 — Sign In page: enter username → click Continue
  // Page HTML: <input id="username"> <button id="btnLogin">
  // ══════════════════════════════════════════════════════════════════════════
  }

  await log('  📋 Step 1/3 — Sign In: entering username...');
  try {
    // Wait in 3-second stages so slow login pages report progress up to 30s.
    if (!await waitForSelectorInStages(page, SEL.STEP1_USERNAME, { label: 'login username field', totalTimeoutMs: 30_000 }, log)) {
      throw new Error('staged wait timed out');
    }
  } catch {
    await failWithDiagnostics(
      'Step 1 failed: Sign In page did not load — input#username not found after 30s.'
    );
  }

  // Use page.type() not page.fill() — Akamai tracks real keystroke timing.
  await page.click(SEL.STEP1_USERNAME);         // focus the field first
  await page.fill(SEL.STEP1_USERNAME, '');       // clear any pre-filled value
  await page.type(SEL.STEP1_USERNAME, username, { delay: 80 });
  await log(`  ✏️  Typed username: ${username}`);

  const ERROR_SEL = '#loginerrorsummary, [data-cy="data-loginerrorsummary-error"], .error-msg';

  let step1Success = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Wait for Akamai sensor to initialise before clicking Continue
      if (attempt === 1) {
        await log(`  ⏱️  Waiting 2 s for Akamai sensor to initialise before clicking Continue...`);
        await page.waitForTimeout(2_000);
      }

      // Remove any existing error message from the DOM so we don't match it instantly on retry
      await page.evaluate((sel) => {
        document.querySelectorAll(sel).forEach(el => el.remove());
      }, ERROR_SEL).catch(() => {});

      await page.click(SEL.STEP1_CONTINUE);
      await waitAfterOperation(page, log, 'username Continue click');
      await log(`  🖱️  Clicked Continue (Step 1 — Sign In) (attempt ${attempt}/3).`);

      // Wait up to 6 seconds to see if the page navigates (password field appears) OR shows an error
      try {
        await Promise.race([
          page.locator(SEL.STEP2_PASSWORD).waitFor({ state: 'visible', timeout: 6_000 }),
          page.locator(ERROR_SEL).waitFor({ state: 'visible', timeout: 6_000 }),
        ]);
      } catch {
        // timeout/race completed without throwing or one of them resolved
      }

      // Check if we succeeded:
      // 1. Password field is visible or present in the HTML/DOM
      // 2. URL contains "password" (case-insensitive)
      // 3. Username field is readonly (indicating we have moved to the password page)
      // 4. Username field is gone/detached
      const urlHasPassword = page.url().toLowerCase().includes('password');
      const passwordExists = await page.evaluate(() => {
        return !!document.querySelector('input#login-pwd, input[type="password"]');
      }).catch(() => false);
      const passwordVisible = await page.locator(SEL.STEP2_PASSWORD).isVisible().catch(() => false);
      const usernameVisible = await page.locator(SEL.STEP1_USERNAME).isVisible().catch(() => false);
      
      const usernameIsReadonly = await page.evaluate(() => {
        const input = document.querySelector('input#username') as HTMLInputElement | null;
        return input ? (input.readOnly || input.hasAttribute('readonly')) : false;
      }).catch(() => false);

      if (passwordVisible || passwordExists || urlHasPassword || usernameIsReadonly || !usernameVisible) {
        await log(`  ✅ Step 1/3 complete (username submitted successfully). Reason: passwordVisible=${passwordVisible}, passwordExists=${passwordExists}, urlHasPassword=${urlHasPassword}, usernameIsReadonly=${usernameIsReadonly}, usernameVisible=${usernameVisible}`);
        step1Success = true;
        break;
      }

      // If username is still visible, check if there is an error message
      const errorVisible = await page.locator(ERROR_SEL).isVisible().catch(() => false);
      if (errorVisible) {
        const errorText = await page.locator(ERROR_SEL).innerText().catch(() => '');
        await log(`  ⚠️  Sign In reported error: "${errorText.trim()}".`);
        
        // Clear, re-type username and click again
        await log('  🔄  Re-typing username and retrying submit...');
        await page.click(SEL.STEP1_USERNAME);
        await page.fill(SEL.STEP1_USERNAME, '');
        await page.type(SEL.STEP1_USERNAME, username, { delay: 100 });
        await page.waitForTimeout(2_000);
      } else {
        await log('  ⏳  Username field still visible (no explicit error). Retrying click...');
        await page.waitForTimeout(2_000);
      }

    } catch (err) {
      await log(`  ⚠️  Continue click failed (attempt ${attempt}): ${err}`);
      await page.waitForTimeout(2_000);
    }
  }

  if (!step1Success) {
    await failWithDiagnostics('Step 1 failed: username was rejected or page did not load Step 2 after 3 attempts.');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // STEP 2 — Password page: enter password → click Continue
  // Page HTML: <input id="login-pwd"> <button id="btnLogin">
  // ══════════════════════════════════════════════════════════════════════════
  await log('  📋 Step 2/3 — Password page: entering password...');
  try {
    if (!await waitForSelectorInStages(page, SEL.STEP2_PASSWORD, { label: 'login password field', totalTimeoutMs: 30_000 }, log)) {
      throw new Error('staged wait timed out');
    }
  } catch {
    await failWithDiagnostics(
      'Step 2 failed: Password page did not appear — input#login-pwd not found after 30s.'
    );
  }

  // Step 2 retry loop — re-enter the password before EACH click attempt,
  // because the site may clear the field if the first click is slow or fails.
  //
  // DEBUG LOGGING:
  //   • Logs the exact password string on every attempt (prefixed ⚠️ DEBUG).
  //   • Attaches a Playwright response listener to capture network traces.
  //     On each failed attempt the accumulated traces are flushed to the log.
  //   Remove / gate these logs behind an env-flag once the issue is resolved.
  {
    const maxAttempts  = 3;
    const retryDelayMs = 2_000;
    let step2Success   = false;

    // Accumulate network traces for the current attempt.
    const networkTraces: string[] = [];

    const onResponse = (response: import('playwright-core').Response) => {
      // Only record requests going to the auth/login domain to keep noise low.
      const url    = response.url();
      const status = response.status();
      const method = response.request().method();
      networkTraces.push(`  [NET] ${method} ${status} ${url}`);
    };
    page.on('response', onResponse);

    try {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Clear traces at the start of each attempt.
        networkTraces.length = 0;

        // Use page.type() not page.fill() — Akamai tracks real keystroke timing.
        // Re-click the field to ensure focus, clear it, then type character-by-character.
        await page.click(SEL.STEP2_PASSWORD);
        await page.fill(SEL.STEP2_PASSWORD, '');  // clear any previous value
        await page.type(SEL.STEP2_PASSWORD, password, { delay: 80 });

        // ── ⚠️ DEBUG — log the exact credential being submitted ──────────────
        await log(`  ⚠️ DEBUG Step 2 attempt ${attempt}/${maxAttempts}: username="${username}" password="${password}"`);
        // ─────────────────────────────────────────────────────────────────────

        // Wait for Akamai's sensor JS to fully build its payload before submitting.
        // Without this pause the wu44b0puoj-* headers are missing / incomplete.
        await log(`  ⏱️  Waiting 2 s for Akamai sensor to initialise before clicking Continue...`);
        await page.waitForTimeout(2_000);

        const btn = page.locator(SEL.STEP2_CONTINUE);
        await btn.waitFor({ state: 'visible', timeout: 5_000 });
        await btn.click();
        await waitAfterOperation(page, log, 'password Continue click');
        await log(`  🖱️  Clicked Continue (Step 2 — Password) (attempt ${attempt}/${maxAttempts}).`);

        try {
          // Success = password field disappears (Step 3 has loaded)
          await page.locator(SEL.STEP2_PASSWORD).waitFor({ state: 'detached', timeout: retryDelayMs });
          await log('  ✔️  Continue (Step 2 — Password) click confirmed (password field detached).');
          await log('  ✅ Step 2/3 complete (password submitted successfully).');
          step2Success = true;
          break;
        } catch {
          // Attempt failed — dump every network call we captured.
          await log(`  ⏳  Password field still visible after ${retryDelayMs}ms (attempt ${attempt}/${maxAttempts}).`);
          await log(`  🌐  Network traces for attempt ${attempt}:`);
          if (networkTraces.length === 0) {
            await log('      (no network responses captured during this attempt)');
          } else {
            for (const trace of networkTraces) {
              await log(trace);
            }
          }
          if (attempt < maxAttempts) {
            await log(`  🔄  Retrying (${attempt}/${maxAttempts})...`);
          }
        }
      }
    } finally {
      // Always remove the listener to avoid leaking it into later steps.
      page.off('response', onResponse);
    }

    if (!step2Success) {
      await failWithDiagnostics('Step 2 failed: button#btnLogin could not be clicked after 3 attempts.');
    }
  }

  // STEP 3a - Verify Identity page: Minimax uses Authenticator, MedRevenu uses Text Message.
  const isMedRevenuStep3 = normalizeOptionText(clientType) === 'medrevenu';
  await log(`  Step 3/3 - Verify Identity: selecting ${isMedRevenuStep3 ? 'Text Message' : 'Microsoft Authenticator'}...`);
  try {
    const methodButton = isMedRevenuStep3 ? SEL.STEP3_TEXT_MSG_BTN : SEL.STEP3_TOTP_BTN;
    const methodLabel = isMedRevenuStep3 ? 'Via Text Message (Step 3a)' : 'Via Microsoft Authenticator (Step 3a)';

    await clickWithRetry(
      page,
      methodButton,
      {
        label: methodLabel,
        maxAttempts: 3,
        retryDelayMs: 2000,
        disappearsSel: methodButton,
        appearsSel: isMedRevenuStep3 ? SEL.STEP3_SMS_INPUT : SEL.STEP3_CODE_INPUT,
      },
      log
    );
    await log(`  Step 3a complete (${isMedRevenuStep3 ? 'Text Message' : 'Microsoft Authenticator'} selected).`);
  } catch {
    await failWithDiagnostics(
      `Step 3a failed: ${isMedRevenuStep3 ? 'Via Text Message' : 'Via Microsoft Authenticator'} button could not be clicked.`
    );
  }

  // STEP 3b - Enter OTP and continue.
  if (isMedRevenuStep3) {
    await log('  Step 3b - Waiting for SMS OTP page...');

    try {
      if (
        !await waitForSelectorInStages(
          page,
          SEL.STEP3_SMS_INPUT,
          {
            label: 'SMS OTP input field',
            totalTimeoutMs: 30_000
          },
          log
        )
      ) {
        throw new Error('staged wait timed out');
      }
    } catch {
      await failWithDiagnostics(
        'Step 3b failed: SMS OTP page did not appear - input#otpBox not found after 30s.'
      );
    }

    const otpRequester = requestOtp;

    if (typeof otpRequester !== 'function') {
      await failWithDiagnostics(
        'Step 3b failed: UHC OTP prompt is not configured.'
      );
      return;
    }

    await log('  Waiting for UHC OTP from UI popup...');

    const otp = (await otpRequester()).replace(/\D/g, '').slice(0, 10);

    if (!/^\d{4,10}$/.test(otp)) {
      await failWithDiagnostics(
        'Step 3b failed: UHC OTP must contain 4 to 10 digits.'
      );
    }

    await page.fill(SEL.STEP3_SMS_INPUT, '');
    await page.fill(SEL.STEP3_SMS_INPUT, otp);

    await log('  Entered SMS OTP into input#otpBox.');

    try {
      await clickWithRetry(
        page,
        SEL.STEP3_SMS_CONTINUE,
        {
          label: 'Continue (SMS OTP)',
          maxAttempts: 3,
          retryDelayMs: 2_000,
          disappearsSel: SEL.STEP3_SMS_INPUT
        },
        log
      );

      await log('  Step 3b complete (SMS OTP submitted successfully).');
    } catch {
      await failWithDiagnostics(
        'Step 3b failed: button#continuebtn could not be clicked after 3 attempts.'
      );
    }
  } else {
    await log('  Step 3b - Authenticator Code page: entering TOTP...');

    try {
      if (
        !await waitForSelectorInStages(
          page,
          SEL.STEP3_CODE_INPUT,
          {
            label: 'authenticator code field',
            totalTimeoutMs: 30_000
          },
          log
        )
      ) {
        throw new Error('staged wait timed out');
      }
    } catch {
      await failWithDiagnostics(
        'Step 3b failed: Authenticator Code page did not appear - input#totp not found after 30s.'
      );
    }

    let totp = generateTOTP();
    const secondsRemaining = totpSecondsRemaining();
    if (secondsRemaining <= 5) {
      await log(`  TOTP expires in ${secondsRemaining}s. Waiting for a fresh authenticator code...`);
      await page.waitForTimeout((secondsRemaining + 1) * 1000);
      totp = generateTOTP();
    }

    await page.fill(SEL.STEP3_CODE_INPUT, '');
    await page.fill(SEL.STEP3_CODE_INPUT, totp);

    await log('  Entered authenticator code into input#totp.');

    try {
      await clickWithRetry(
        page,
        SEL.STEP3_VERIFY,
        {
          label: 'Continue (TOTP)',
          maxAttempts: 3,
          retryDelayMs: 2_000,
          disappearsSel: SEL.STEP3_CODE_INPUT
        },
        log
      );

      await log('  Step 3b complete (TOTP submitted successfully).');
    } catch {
      await failWithDiagnostics(
        'Step 3b failed: button#btnVerify could not be clicked after 3 attempts.'
      );
    }
  }
  // ── Wait for post-login dashboard ─────────────────────────────────────────
  await log('  ⏳  Waiting for dashboard to confirm successful login...');
  try {
    if (!await waitForSelectorInStages(page, SEL.CLAIMS_NAV, { label: 'post-login dashboard', totalTimeoutMs: 30_000 }, log)) {
      throw new Error('staged wait timed out');
    }
    await log('✅ Login complete — dashboard confirmed.');
  } catch {
    await failWithDiagnostics(
      'Login verification failed: dashboard not visible 30s after OTP submission.'
    );
  }
}

// ── Navigate to Claim Status ──────────────────────────────────────────────────
async function navigateToClaimSearch(page: Page, sendEvent: SendEvent) {
  const log = (msg: string) => sendEvent({ type: 'log', message: msg });

  await log('Navigating to Claim Status search...');

  try {
    await page.waitForSelector(SEL.SEARCH_TYPE_BTN, { timeout: 1_500 });
    await log('  Already on Claim Status search.');
    await closeNavDropdownIfOpen(page, log);
    return;
  } catch { /* not already on claim search */ }

  try {
    await log('  Opening Claims & Payments menu...');
    await page.click(SEL.CLAIMS_NAV, { timeout: 8_000 });
    await waitAfterOperation(page, log, 'Claims & Payments menu click');
    await page.locator('button:has-text("Look up a Claim"), [role="menuitem"]:has-text("Look up a Claim")').first().click({ timeout: 8_000 });
    await waitAfterOperation(page, log, 'Look up a Claim click');
    await page.waitForSelector(SEL.SEARCH_TYPE_BTN, { timeout: 15_000 });
    await log('  Arrived at Claim Status via Look up a Claim menu.');
    await closeNavDropdownIfOpen(page, log);
    return;
  } catch (err) {
    await log(`  Look up a Claim menu navigation failed: ${err}. Falling back to direct claim link...`);
  }

  await page.goto(CLAIMS_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await waitAfterOperation(page, log, 'direct claim search navigation');
  await page.waitForSelector(SEL.SEARCH_TYPE_BTN, { timeout: 15_000 });
  await log('  Arrived at Claim Status (direct URL fallback).');
  await closeNavDropdownIfOpen(page, log);
}

// ── Select search type ───────────────────────────────────────────────────────
async function selectSearchType(page: Page, mode: 'memberDob' | 'nameDob' | 'memberName' = 'memberDob', log?: (msg: string) => Promise<void>) {
  await page.click(SEL.SEARCH_TYPE_BTN);
  if (log) await waitAfterOperation(page, log, 'search type dropdown click');
  await page.waitForSelector('[role="option"]', { timeout: 5_000 });
  if (mode === 'memberName') {
    const optionLocator = page.locator('[role="option"]', {
      hasText: /member\s*id\s*&\s*member\s*name/i
    });
    if (await optionLocator.count() > 0) {
      await optionLocator.first().click();
    } else {
      await page.locator('[role="option"]', { hasText: /member\s*id.*name/i }).first().click();
    }
    if (log) await waitAfterOperation(page, log, 'search type option selection');
  } else if (mode === 'nameDob') {
    // Look for option containing "name" and "birth" / "DOB" dynamically
    const optionLocator = page.locator('[role="option"]', {
      hasText: /name.*birth|name.*dob/i
    });
    if (await optionLocator.count() > 0) {
      await optionLocator.first().click();
    } else {
      // Fallback: search for any option containing "name"
      const fallbackLocator = page.locator('[role="option"]', {
        hasText: /name/i
      });
      await fallbackLocator.first().click();
    }
    if (log) await waitAfterOperation(page, log, 'search type option selection');
  } else {
    await page.click(SEL.SEARCH_OPTION);
    if (log) await waitAfterOperation(page, log, 'search type option selection');
  }
  await page.waitForTimeout(OPERATION_SETTLE_MS);
}

// ── Split patient name into first and last name parts safely ─────────────────
function getPatientNameParts(claim: ClaimRow): { firstName: string; lastName: string } {
  const explicitFirstName = String(claim.patientFirstName || claim['Patient First Name'] || claim['First Name'] || '').trim();
  const explicitLastName = String(claim.patientLastName || claim['Patient Last Name'] || claim['Last Name'] || '').trim();
  if (explicitFirstName || explicitLastName) {
    return {
      firstName: cleanGivenName(explicitFirstName),
      lastName: explicitLastName,
    };
  }

  // Specifically locate the "Patient Name" column value (case-insensitive, space-insensitive)
  let patientName = '';
  for (const key of Object.keys(claim)) {
    const cleanKey = key.trim().toLowerCase().replace(/\s+/g, ' ');
    if (cleanKey === 'patient' || cleanKey === 'patient name') {
      patientName = String(claim[key] ?? '').trim();
      break;
    }
  }

  // Case-insensitive property fallbacks
  if (!patientName) {
    patientName = String(claim['Patient'] || claim['patient'] || claim['Patient Name'] || claim['patientName'] || claim['patientname'] || '').trim();
  }

  let firstName = '';
  let lastName = '';

  if (patientName) {
    if (patientName.includes(',')) {
      const [lastPart, ...firstPartsRaw] = patientName.split(',');
      lastName = lastPart.trim();
      firstName = cleanGivenName(firstPartsRaw.join(',').trim());
    } else {
      // Safe fallback if the comma is omitted
      const parts = removeTrailingMiddleInitials(patientName.split(/\s+/).filter(Boolean));
      if (parts.length >= 2) {
        firstName = parts.slice(0, -1).join(' ').trim();
        lastName = parts[parts.length - 1].trim();
      } else {
        firstName = patientName;
        lastName = patientName;
      }
    }
  }

  return { firstName, lastName };
}

function removeTrailingMiddleInitials(parts: string[]): string[] {
  const cleaned = [...parts];
  while (cleaned.length > 1 && /^[A-Za-z]\.?$/.test(cleaned[cleaned.length - 1])) {
    cleaned.pop();
  }
  return cleaned;
}

function cleanGivenName(value: string): string {
  return removeTrailingMiddleInitials(value.split(/\s+/).filter(Boolean)).join(' ').trim();
}

function isMemberFoundNoClaimFoundMessage(message: string): boolean {
  const text = message.toLowerCase().replace(/\s+/g, ' ');
  return text.includes('member found') && text.includes('no claim found');
}

// ── Fill and submit claim search form ─────────────────────────────────────────
async function searchClaim(page: Page, claim: ClaimRow, searchMode: 'memberId' | 'name', clientType: string, sendEvent: SendEvent) {
  const log = (msg: string) => sendEvent({ type: 'log', message: msg });

  // Close Claims & Payments dropdown if it is open/expanded and blocking UI
  await closeNavDropdownIfOpen(page, log);

  const isMedRevenu = normalizeOptionText(clientType) === 'medrevenu';

  await selectSearchType(page, isMedRevenu ? 'memberName' : (searchMode === 'name' ? 'nameDob' : 'memberDob'), log);

  try { await page.check(SEL.TIN_RADIO, { timeout: 2_000 }); } catch { /* already set */ }

  if (isMedRevenu || searchMode === 'name') {
    const { firstName, lastName } = getPatientNameParts(claim);
    await log(`  📝  Filling patient name: First="${firstName}" | Last="${lastName}"`);
    if (isMedRevenu) {
      await page.fill(SEL.MEMBER_ID, '');
      await page.fill(SEL.MEMBER_ID, claim.subscriberNo);
    }
    await page.fill(SEL.FIRST_NAME, '');
    await page.fill(SEL.FIRST_NAME, firstName);
    await page.fill(SEL.LAST_NAME, '');
    await page.fill(SEL.LAST_NAME, lastName);
  } else {
    await page.fill(SEL.MEMBER_ID, '');
    await page.fill(SEL.MEMBER_ID, claim.subscriberNo);
  }

  const dobInput = page.locator(SEL.DOB).first();
  if (await dobInput.isVisible().catch(() => false)) {
    await dobInput.fill('');
    await dobInput.fill(claim.patientDOB);
  } else if (!isMedRevenu) {
    await page.fill(SEL.DOB, '');
    await page.fill(SEL.DOB, claim.patientDOB);
  }

  try { await page.check(SEL.DATE_CUSTOM, { timeout: 2_000 }); } catch { /* already set */ }

  await page.fill(SEL.FIRST_SVC_DATE, '');
  await page.fill(SEL.FIRST_SVC_DATE, claim.serviceDate);
  await page.fill(SEL.LAST_SVC_DATE, '');
  await page.fill(SEL.LAST_SVC_DATE, claim.serviceDate);

  if (isMedRevenu || searchMode === 'name') {
    await log(isMedRevenu
      ? `  🔍  Search: Subscriber=${claim.subscriberNo} | Name="${claim.patientName || ''}" | Date=${claim.serviceDate}`
      : `  🔍  Search: Name="${claim.patientName || ''}" | DOB=${claim.patientDOB} | Date=${claim.serviceDate}`
    );
  } else {
    await log(`  🔍  Search: Subscriber=${claim.subscriberNo} | DOB=${claim.patientDOB} | Date=${claim.serviceDate}`);
  }

  try {
    await page.click(SEL.SUBMIT_BTN, { timeout: 5_000 });
  } catch {
    await page.click(SEL.SUBMIT_BTN_ALT);
  }
  await waitAfterOperation(page, log, 'claim search submit click');
}

// ── Find matching claim in results (with popup-retry) ───────────────────────────
//
// After each search submit we wait for results OR the error popup.
// Popup behaviour:
//   Attempt 1 → dismiss popup → retry the search.
//   Attempt 2 → dismiss popup → return { popupError } so the caller can
//               write the popup message into the BotStatus column.
//
async function waitForOverlayLoader(page: Page, log: (msg: string) => Promise<void>, readySelector?: string) {
  try {
    await page.waitForTimeout(300);
    const overlaySelector = '.abyss-loading-overlay-root';
    const hasVisibleOverlay = await page.locator(overlaySelector).evaluateAll((elements) => {
      const isVisible = (element: Element) => {
        const style = window.getComputedStyle(element);
        const box = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && box.width > 0 && box.height > 0;
      };
      return elements.some(isVisible);
    }).catch(() => false);

    if (!hasVisibleOverlay) return;

    await log('  Loading overlay detected. Waiting for loader to complete...');
    const resultHandle = await page.waitForFunction(
      ({ overlaySelector: currentOverlaySelector, readySelector: currentReadySelector }) => {
        const isVisible = (element: Element) => {
          const style = window.getComputedStyle(element);
          const box = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && box.width > 0 && box.height > 0;
        };

        if (currentReadySelector && Array.from(document.querySelectorAll(currentReadySelector)).some(isVisible)) {
          return 'ready';
        }

        return Array.from(document.querySelectorAll(currentOverlaySelector)).some(isVisible) ? false : 'hidden';
      },
      { overlaySelector, readySelector },
      { timeout: readySelector ? 2_000 : 4_000, polling: 250 },
    ).catch(() => null);

    const result = resultHandle ? await resultHandle.jsonValue() : null;
    if (result === 'ready') {
      await log('  Loading overlay is still visible, but page content is ready. Continuing.');
      return;
    }
    if (result !== 'hidden') {
      await log('  Loading overlay still visible after wait. Continuing with the next check.');
      return;
    }
    await log('  Loading overlay completed.');
    return;

  } catch (err) {
    await log('  ??  Loading overlay check could not complete cleanly. Continuing with the next check.');
  }
}

// ── Wait for sub-loaders on detail page to complete ──────────────────────────
async function waitForClaimDetailLoaders(page: Page, log: (msg: string) => Promise<void>) {
  await log('  ⏳  Waiting for UHC claim details to load and render...');
  const coreDetailSelector = '[data-testid="overview-claim-number"], [data-testid="overview-claim-number-button"], [data-testid="cs-claim-number"], [data-testid="pi-patient-name-content"], [data-testid="line-items-container"]';
  await waitForOverlayLoader(page, log, coreDetailSelector);

  const hasCoreDetailContent = await page.locator(coreDetailSelector).first().isVisible().catch(() => false);
  if (hasCoreDetailContent) {
    await log('  Claim detail content is visible. Continuing.');
    return;
  }

  // Wait for all core card-level "Please wait while we retrieve..." messages and spinner elements to disappear
  try {
    await page.waitForFunction(() => {
      const claimNum = document.querySelector('[data-testid="overview-claim-number"], [data-testid="cs-claim-number"]')?.textContent?.trim();
      const patientName = document.querySelector('[data-testid="overview-patient-name"], [data-testid="pi-patient-name-content"]')?.textContent?.trim();

      const loaders = Array.from(document.querySelectorAll('[data-testid="loading-error-message"]'));
      const hasPleaseWait = loaders.some(el => {
        const txt = el.textContent || '';
        // Only block on loaders for Overview, Patient, Billing, and Line Items
        return txt.includes('Please wait while') && 
          (txt.includes('Overview') || txt.includes('Patient') || txt.includes('Billing') || txt.includes('details and line items'));
      });
      
      const hasSpinners = !!document.querySelector('[data-testid="bs-loading"], [data-testid="cs-loading"]');
      
      return !!(claimNum && patientName) && !hasPleaseWait && !hasSpinners;
    }, { timeout: 1_500 });
    await log('  ✅  All core card-level loaders and spinners have cleared.');
  } catch {
    await log('  Card-level loaders did not fully clear within 1.5s. Continuing with visible content checks...');
  }

  // Also verify that we have at least some populated content elements (not just empty templates)
  try {
    const dataLocator = page.locator(coreDetailSelector);
    await dataLocator.first().waitFor({ state: 'visible', timeout: 1_500 });
  } catch {
    await log('  Claim detail content did not become visible within 1.5s. Continuing with available page data...');
  }
  
  await page.waitForTimeout(300); // small settle time for accordion states
  await log('  ✅  Detail page loading checks completed.');
}

// ── Expand all closed accordion panels ─────────────────────────────────────────
async function expandAllAccordions(page: Page, log: (msg: string) => Promise<void>) {
  try {
    const items = await page.locator('[data-testid$="-accordion-item"]').all();
    for (const item of items) {
      const state = await item.getAttribute('data-state');
      if (state === 'closed') {
        const testid = await item.getAttribute('data-testid');
        const headerTestid = testid?.replace('-abyss-accordion-item', '-header-abyss-accordion-header');
        if (headerTestid) {
          await log(`  📂  Expanding accordion: ${testid}...`);
          await page.locator(`[data-testid="${headerTestid}"]`).click({ force: true });
          await page.waitForTimeout(300);
        }
      }
    }
  } catch (err) {
    await log(`  ⚠️  Error expanding accordions: ${err}`);
  }
}

// ── Scrape details using testids ──────────────────────────────────────────────
async function expandAllClaimLineRows(page: Page, log: (msg: string) => Promise<void>) {
  try {
    const buttons = await page.locator('td[data-testid="row-content-yellow"] button[aria-label="data-table-expand-row-button"]').all();
    let expanded = 0;

    for (const button of buttons) {
      const iconText = (await button.innerText().catch(() => '')).trim();
      const parentClass = (await button.locator('xpath=ancestor::td[1]').getAttribute('class').catch(() => '')) || '';
      const isClosed = iconText.includes('keyboard_arrow_down') || parentClass.includes('isYellowExpandedRow-false');

      if (!isClosed) continue;

      await button.click({ force: true });
      expanded++;
      await page.waitForTimeout(200);
    }

    if (expanded > 0) {
      await log(`  📂  Expanded ${expanded} closed claim line row(s).`);
    }
  } catch (err) {
    await log(`  ⚠️  Error expanding claim line rows: ${err}`);
  }
}

async function scrapeClaimSummaryPage(page: Page, options: { targetProcessedDate?: string } = {}): Promise<Record<string, string>> {
  return await page.evaluate((targetProcessedDate) => {
    const data: Record<string, string> = {};
    const isServiceCodeInPage = (value: string): boolean => {
      const cleaned = value.trim().toUpperCase();
      return /^\d{5}$/.test(cleaned) || /^[A-Z]\d{4}$/.test(cleaned);
    };
    const getAmountFromText = (value: string | undefined): string => {
      const match = (value || '').match(/\$[0-9,]+(?:\.\d{2})?/);
      return match ? match[0] : '';
    };
    const normalizeReasonText = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const classifyPatientResponsibility = (codes: string[]): string[] => {
      const categories: string[] = [];
      const text = normalizeReasonText(codes.join(' '));
      if (text.includes('copay') || text.includes('copayment')) categories.push('Co-Pay');
      if (text.includes('coinsurance') || text.includes('coins')) categories.push('Coinsurance');
      if (text.includes('deductible') || text.includes('deduct')) categories.push('Deductible');
      return Array.from(new Set(categories));
    };
    const testIds = [
      'overview-claim-number',
      'overview-status',
      'overview-patient-name',
      'overview-member-id',
      'overview-first-dos',
      'overview-total-billed',
      'overview-network-status',
      'overview-adjudication-status',
      'overview-pan',
      'recieved-date',
      'processed-date',
      'bs-billed-content',
      'bs-total-paid-content',
      'bs-patient-content',
      'bs-adjustment-content',
      'cs-claim-number',
      'cs-first-service-date',
      'cs-network-status',
      'cs-fee-for-service',
      'pi-subscriber-content',
      'pi-patient-name-content',
      'pi-dob-content',
      'pi-member-id-content',
      'pi-policy-number-content',
      'pi-insurance-type',
      'pi-billing-provider',
      'pi-tax-id',
      'cob-insurance-type',
      'cob-policy',
      'cob-payer',
      'cob-payment-type',
      'cob-paid-amount',
      'drg-content',
      'diagnosis-codes-content'
    ];

    const bodyText = document.body.innerText || '';
    if (/NO\s+DATA\s+AVAILABLE/i.test(bodyText) || /Payment details are not available/i.test(bodyText)) {
      data['claim-in-process'] = 'true';
    }

    const parseDateValue = (value: string): number => {
      const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (!match) return 0;
      return Date.UTC(Number(match[3]), Number(match[1]) - 1, Number(match[2]));
    };
    const targetProcessedTimestamp = parseDateValue(targetProcessedDate || '');

    testIds.forEach(id => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      if (el) {
        const text = el.innerText ? el.innerText.trim() : '';
        if (text) data[id] = text;
      }
    });

    // ── Extract Payer Name ──
    let payerName = 'UnitedHealthcare';
    const payerMenu = document.querySelector('[data-testid="payer-menu-abyss-button-root"]')?.textContent?.trim();
    if (payerMenu) {
      const parts = payerMenu.split('-');
      if (parts.length >= 2) {
        payerName = parts[parts.length - 1].trim();
      } else {
        payerName = payerMenu;
      }
    }
    data['payer-name'] = payerName;

    // ── Extract Payment Info ──
    const paymentHeaders = Array.from(document.querySelectorAll('[data-testid="data-table-header"]'));
    let payIssueDateCol = -1;
    let payNumCol = -1;
    let payAmountCol = -1;
    paymentHeaders.forEach((th, idx) => {
      const id = th.querySelector('span > span')?.id || '';
      if (id.includes('payment-issue-date')) payIssueDateCol = idx;
      if (id.includes('payment-number')) payNumCol = idx;
      if (id.includes('payment-amount')) payAmountCol = idx;
      
      const txt = th.textContent || '';
      if (txt.includes('Payment issue date')) payIssueDateCol = idx;
      if (txt.includes('Payment number')) payNumCol = idx;
      if (txt.includes('Payment amount')) payAmountCol = idx;
    });

    const issueDateHeader = document.querySelector('#payment-issue-date-label') || document.querySelector('[data-testid="payment-info"]');
    if (issueDateHeader) {
      const table = issueDateHeader.closest('table');
      if (table) {
        const localHeaders = Array.from(table.querySelectorAll('[data-testid="data-table-header"], th'));
        localHeaders.forEach((th, idx) => {
          const id = th.querySelector('span > span')?.id || '';
          const txt = th.textContent || '';
          if (id.includes('payment-issue-date') || txt.includes('Payment issue date')) payIssueDateCol = idx;
          if (id.includes('payment-number') || txt.includes('Payment number')) payNumCol = idx;
          if (id.includes('payment-amount') || txt.includes('Payment amount')) payAmountCol = idx;
        });

        const paymentRows = Array.from(table.querySelectorAll('tbody tr'))
          .map(row => {
            const cells = row.querySelectorAll('td');
            return {
              issueDate: payIssueDateCol >= 0 && payIssueDateCol < cells.length ? cells[payIssueDateCol].textContent?.trim() || '' : '',
              number: payNumCol >= 0 && payNumCol < cells.length ? cells[payNumCol].textContent?.trim() || '' : '',
              amount: payAmountCol >= 0 && payAmountCol < cells.length ? cells[payAmountCol].textContent?.trim() || '' : '',
            };
          })
          .filter(row => row.issueDate || row.number || row.amount);

        if (paymentRows.length > 0) {
          data['payment-rows-json'] = JSON.stringify(paymentRows);
          data['payment-issue-date'] = paymentRows.map(row => row.issueDate).filter(Boolean).join(', ');
          data['payment-number'] = paymentRows.map(row => row.number).filter(Boolean).join(', ');
          data['payment-amount'] = paymentRows.map(row => row.amount).filter(Boolean).join(' + ');
        }
      }
    }

    if (!data['patient-responsibility']) {
      data['patient-responsibility'] = getAmountFromText(data['bs-patient-content']);
    }

    // Fallback: search by regex inside payments accordion container
    const paymentsAccordion = document.querySelector('[data-testid="payments-accordion-abyss-accordion-item"]') || document.body;
    const cardText = (paymentsAccordion as HTMLElement).innerText || '';
    const dates = cardText.match(/\b\d{2}\/\d{2}\/\d{4}\b/g) || [];
    const numbers = cardText.match(/\b\d{7,12}\b/g) || [];
    
    if (!data['payment-issue-date'] && dates.length > 0) {
      data['payment-issue-date'] = dates[0] || '';
    }
    if (!data['payment-number'] && numbers.length > 0) {
      data['payment-number'] = numbers[0] || '';
    }

    // ── Extract Line Items ──
    const lineRows = document.querySelectorAll('[data-testid="data-table-row"]');
    const lines: string[] = [];
    const lineItemsData: any[] = [];
    const processedGroupDates = Array.from(document.querySelectorAll('[data-testid="data-table-group-header-row"]'))
      .map(row => {
        const match = (row.textContent || '').match(/PROCESSED DATE:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
        return match?.[1] || '';
      })
      .filter(Boolean);
    const sortedLineProcessedDates = Array.from(new Set(processedGroupDates))
      .sort((left, right) => parseDateValue(right) - parseDateValue(left));
    const selectedLineProcessedDate = targetProcessedTimestamp
      ? sortedLineProcessedDates.find(date => parseDateValue(date) === targetProcessedTimestamp)
        || sortedLineProcessedDates.find(date => parseDateValue(date) < targetProcessedTimestamp)
        || sortedLineProcessedDates[sortedLineProcessedDates.length - 1]
        || targetProcessedDate
      : sortedLineProcessedDates[0] || '';
    if (selectedLineProcessedDate) {
      data['processed-date'] = selectedLineProcessedDate;
    }
    if (sortedLineProcessedDates.length > 0) {
      data['all-processed-dates'] = sortedLineProcessedDates.join(', ');
    }

    const findNearestProcessedGroupDate = (row: Element): string => {
      let current = row.previousElementSibling;
      while (current) {
        if (current.getAttribute('data-testid') === 'data-table-group-header-row') {
          const match = (current.textContent || '').match(/PROCESSED DATE:\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
          return match?.[1] || '';
        }
        current = current.previousElementSibling;
      }
      return '';
    };

    lineRows.forEach((row, idx) => {
      const rowProcessedDate = findNearestProcessedGroupDate(row);
      if (selectedLineProcessedDate && rowProcessedDate && parseDateValue(rowProcessedDate) !== parseDateValue(selectedLineProcessedDate)) {
        return;
      }

      if (row.querySelector('[data-testid="expanded-row-container"]')) {
        return;
      }
      if (!row.querySelector('td[data-testid="row-content-yellow"]')) {
        return;
      }

      const cells = Array.from(row.querySelectorAll('td, th, .abyss-table-cell'));
      const cellTexts = cells.map(c => (c.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean);
      const rowText = row.textContent || '';
      const paymentNumber = data['payment-number'] || '';

      if (paymentNumber && cellTexts.some(text => text.trim() === paymentNumber)) {
        return;
      }
      
      const nextRow = row.nextElementSibling;
      const expandedContainer = (nextRow && nextRow.querySelector('[data-testid="expanded-row-container"]'))
        ? nextRow
        : null;

      const carcs = expandedContainer
        ? Array.from(expandedContainer.querySelectorAll('[data-testid="expanded-row-carc-codes-text"]'))
            .map(el => el.textContent?.trim().replace(/\s+/g, ' '))
            .filter(Boolean)
        : [];

      const remarks = expandedContainer
        ? Array.from(expandedContainer.querySelectorAll('[data-testid="expanded-row-remark-codes-text"]'))
            .map(el => el.textContent?.trim().replace(/\s+/g, ' '))
            .filter(Boolean)
        : [];

      const remits = expandedContainer
        ? Array.from(expandedContainer.querySelectorAll('[data-testid="expanded-row-remittance-codes-text"]'))
            .map(el => el.textContent?.trim().replace(/\s+/g, ' '))
            .filter(Boolean)
        : [];
      
      let lineStr = `${rowProcessedDate ? `Processed Date ${rowProcessedDate} - ` : ''}Line ${lines.length + 1}: ${cellTexts.join(' | ')}`;
      const extra: string[] = [];
      if (carcs.length > 0) {
        extra.push(`CARC: ${carcs.join('; ')}`);
      }
      if (remarks.length > 0) {
        extra.push(`Remark: ${remarks.join('; ')}`);
      }
      if (remits.length > 0) {
        extra.push(`Remittance: ${remits.join('; ')}`);
      }
      if (extra.length > 0) {
        lineStr += ` (${extra.join('; ')})`;
      }

      // Parse structured line items for BotClaimResult
      let cptCode = '';
      for (const cell of cellTexts) {
        const cleaned = cell.trim();
        if (isServiceCodeInPage(cleaned)) {
          cptCode = cleaned;
          break;
        }
      }
      if (!cptCode && cellTexts.length > 3 && isServiceCodeInPage(cellTexts[3])) {
        cptCode = cellTexts[3];
      }
      if (!cptCode) return;
      lines.push(lineStr);

      const dollarValues = cellTexts.filter(c => c.includes('$'));
      let billedAmount = '$0.00';
      let paidAmount = '$0.00';
      if (dollarValues.length >= 2) {
        billedAmount = dollarValues[dollarValues.length - 2];
        paidAmount = dollarValues[dollarValues.length - 1];
      } else if (dollarValues.length === 1) {
        billedAmount = dollarValues[0];
      }

      const getAmount = (pattern: RegExp, defaultVal: string): string => {
        const m = rowText.match(pattern);
        return m ? m[1].trim() : defaultVal;
      };

      const allowedAmount = getAmount(/Allowed(?: Amount)?[:\s]*\$([0-9\.,]+)/i, billedAmount);
      const deductible = getAmount(/Deductible[:\s]*\$([0-9\.,]+)/i, '$0.00');
      const copay = getAmount(/(?:Co-pay|Copay|Copayment)[:\s]*\$([0-9\.,]+)/i, '$0.00');
      const coinsurance = getAmount(/(?:Co-insurance|Coinsurance)[:\s]*\$([0-9\.,]+)/i, '$0.00');

      let denialReason = '';
      if (carcs.length > 0) {
        denialReason = carcs.join(', ');
      } else if (remarks.length > 0) {
        denialReason = remarks.join(', ');
      } else {
        denialReason = 'Service denied';
      }

      lineItemsData.push({
        processedDate: rowProcessedDate || selectedLineProcessedDate || data['processed-date'] || '',
        cptCode,
        billedAmount,
        paidAmount,
        allowedAmount: allowedAmount.startsWith('$') ? allowedAmount : `$${allowedAmount}`,
        deductible: deductible.startsWith('$') ? deductible : `$${deductible}`,
        copay: copay.startsWith('$') ? copay : `$${copay}`,
        coinsurance: coinsurance.startsWith('$') ? coinsurance : `$${coinsurance}`,
        patientResponsibility: data['patient-responsibility'] || '',
        patientResponsibilityCategories: classifyPatientResponsibility(carcs),
        carcs,
        remarks,
        remits,
        denialReason
      });
    });

    if (lines.length > 0) {
      data['line-items'] = lines.join('\n');
    }
    data['line-items-json'] = JSON.stringify(lineItemsData);

    return data;
  }, options.targetProcessedDate || '');
}

// ── Format the scraped details into a clean text blob ──────────────────────────
function formatScrapedDataBlob(data: Record<string, string>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (
      key === 'line-items' ||
      key === 'line-items-json' ||
      key === 'payment-issue-date' ||
      key === 'payment-number' ||
      key === 'payment-amount' ||
      key === 'payment-rows-json' ||
      key === 'patient-responsibility' ||
      key === 'claim-in-process' ||
      key === 'payer-name'
    ) continue;
    const lines = value.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length === 1) {
      const humanLabel = key.replace(/^(overview|bs|cs|pi|cob)-/, '').replace(/-/g, ' ');
      parts.push(`${humanLabel}: ${lines[0]}`);
    } else if (lines.length >= 2) {
      parts.push(`${lines[0]}: ${lines.slice(1).join(' ')}`);
    }
  }

  if (data['line-items']) {
    parts.push('\nClaim details line items:');
    parts.push(data['line-items']);
  }

  if (data['payer-name'] || data['payment-number'] || data['payment-issue-date']) {
    parts.push('\npayment details:');
    if (data['payer-name']) parts.push(`Payer Name: ${data['payer-name']}`);
    if (data['payment-number']) parts.push(`Payment Number: ${data['payment-number']}`);
    if (data['payment-amount']) parts.push(`Payment Amount: ${data['payment-amount']}`);
    if (data['payment-issue-date']) parts.push(`Payment Issue Date: ${data['payment-issue-date']}`);
  }

  return parts.join('\n');
}

// ── Extract label-value pair values safely ──────────────────────────────────────
function buildUhcBotFieldsFromScrapedData(
  scrapedData: Record<string, string>,
  payload: Record<string, string>,
  claim: ClaimRow,
  clientType: string,
  options: { splitPaymentRowsByProcessedDate?: boolean } = {},
): Partial<BotFields> {
  const fields: Partial<BotFields> = {};
  fields.BotClaimDetails = formatScrapedDataBlob(scrapedData);
  fields.BotClaimNumber = extractValueFromContent(scrapedData['overview-claim-number'] || scrapedData['cs-claim-number'] || payload.claimNumber);
  fields.BotClaimStatus = extractValueFromContent(scrapedData['overview-status'] || scrapedData['overview-adjudication-status'] || payload.claimStatus);
  fields.BotPaidAmount = extractValueFromContent(scrapedData['bs-total-paid-content'] || payload.totalPaidAmount);
  fields.BotBilledAmount = extractValueFromContent(scrapedData['bs-billed-content'] || payload.totalBilledAmount);
  const receivedDate = extractValueFromContent(scrapedData['recieved-date']);
  fields.BotProcessedDate = extractValueFromContent(scrapedData['processed-date'] || payload.processedDate);

  let lineItems: any[] = [];
  try {
    if (scrapedData['line-items-json']) lineItems = JSON.parse(scrapedData['line-items-json']);
  } catch { /* ignore */ }

  const paymentRows = parsePaymentRows(scrapedData['payment-rows-json']);
  if (paymentRows.length > 0) fields.BotCheckEFTNumber = uniqueJoin(paymentRows.map(row => row.number), fields.BotCheckEFTNumber || 'N/A');

  const lineProcessedDates = uniqueSortedProcessedDates(lineItems.map(item => item?.processedDate));
  if (lineProcessedDates.length > 0) fields.BotProcessedDate = lineProcessedDates.join(', ');
  const allProcessedDates = uniqueSortedProcessedDates(String(scrapedData['all-processed-dates'] || fields.BotProcessedDate || '').split(','));
  const paymentMappingProcessedDates = options.splitPaymentRowsByProcessedDate ? allProcessedDates : lineProcessedDates;

  const paidCptCodes = new Set(lineItems.filter(item => parseMoney(item.paidAmount) > 0).map(item => item.cptCode).filter(Boolean));
  const deniedLineItems = lineItems.filter(item => !paidCptCodes.has(item.cptCode));
  const lineItemCarcs = formatCodesByCpt(deniedLineItems, 'carcs');
  const lineItemRemarks = formatCodesByCpt(deniedLineItems, 'remarks');
  if (lineItemCarcs) {
    fields.BotDenialReasonCode = lineItemCarcs;
    fields.BotDenialDescription = undefined;
  }
  if (lineItemRemarks) fields.BotRemarkCodes = lineItemRemarks;

  const numericTotalPaid = parseMoney(fields.BotPaidAmount || '0.00');
  const checkNumber = fields.BotCheckEFTNumber || uniqueJoin(paymentRows.map(row => row.number), scrapedData['payment-number'] || 'N/A');
  const checkDateFallback = uniqueJoin(paymentRows.map(row => row.issueDate), scrapedData['payment-issue-date'] || fields.BotProcessedDate || 'N/A');
  const paymentAmount = scrapedData['payment-amount'] || fields.BotPaidAmount || '$0.00';
  const payerName = cleanPayerName(scrapedData['payer-name']);
  const processedDate = fields.BotProcessedDate || 'N/A';
  const claimReceivedDate = firstNonEmpty(receivedDate, scrapedData['recieved-date'], 'N/A');
  const claimNumber = fields.BotClaimNumber || 'N/A';
  const serviceDate = claim.serviceDate;
  const isMedRevenu = normalizeOptionText(clientType) === 'medrevenu';
  const claimServiceCode = getClaimServiceCode(claim);
  const medRevenuLineItems = isMedRevenu ? filterLineItemsByServiceCode(lineItems, claimServiceCode) : lineItems;
  const medRevenuLinePaidTotal = medRevenuLineItems.reduce((sum, item) => sum + parseMoney(item.paidAmount), 0);
  const adjudicationLineItems = isMedRevenu ? medRevenuLineItems : lineItems;

  if (scrapedData['claim-in-process'] === 'true' && paymentRows.length === 0 && !hasLineAdjudicationDetails(adjudicationLineItems)) {
    fields.BotClaimResult = `DOS ${serviceDate} Claim received on ${claimReceivedDate} is in process by ${payerName} on Claim # ${claimNumber}.`;
    return fields;
  }

  if (isMedRevenu) {
    fields.BotPaidAmount = formatMoney(String(medRevenuLinePaidTotal));
    const medRevenuHasPaidLine = medRevenuLinePaidTotal > 0;
    const medRevenuDeniedLineItems = medRevenuHasPaidLine ? [] : medRevenuLineItems;
    fields.BotDenialReasonCode = formatCodesByCpt(medRevenuDeniedLineItems, 'carcs') || undefined;
    fields.BotRemarkCodes = formatCodesByCpt(medRevenuDeniedLineItems, 'remarks') || undefined;

    fields.BotClaimResult = joinClaimResultSections(groupLineItemsByProcessedDate(medRevenuLineItems, processedDate).map(group => {
      const groupLinePaidTotal = group.lineItems.reduce((sum, item) => sum + parseMoney(item.paidAmount), 0);
      const groupPaidAmountText = formatMoney(String(groupLinePaidTotal));
      const groupDeniedLineItems = groupLinePaidTotal > 0 ? [] : group.lineItems;
      const groupDenialReasonText = formatMedRevenuDenialReason(groupDeniedLineItems, fields.BotDenialReasonCode || fields.BotDenialDescription);
      const groupProcessedDate = group.processedDate || processedDate;
      const groupPaymentRows = paymentRowsForProcessedDate(groupProcessedDate, paymentMappingProcessedDates, paymentRows);
      const groupCheckAmountText = formatCheckAmounts(groupPaymentRows, paymentAmount, groupLinePaidTotal);
      const groupCheckNumber = uniqueJoin(groupPaymentRows.map(row => row.number), checkNumber);
      const groupCheckDate = checkDateForProcessedDate(groupProcessedDate, paymentMappingProcessedDates, paymentRows, checkDateFallback);
      if (groupLinePaidTotal > 0) {
        return `DOS ${serviceDate}: Checked IEHP portal Claim Received on ${claimReceivedDate} and Processed on ${groupProcessedDate}. Paid on ${groupCheckDate} paid amount ${groupPaidAmountText} EFT/Check # ${groupCheckNumber}. Check Amount: ${groupCheckAmountText}. Claim #: ${claimNumber}`;
      }
      return `DOS ${serviceDate}: Checked IEHP portal Claim Received on ${claimReceivedDate} and Processed on ${groupProcessedDate}. Denied on ${groupCheckDate} denial reason ${groupDenialReasonText} EFT/Check # ${groupCheckNumber}. Check Amount: ${groupCheckAmountText}. Claim #: ${claimNumber}`;
    }));
    return fields;
  }

  fields.BotClaimResult = joinClaimResultSections(groupLineItemsByProcessedDate(lineItems, processedDate).map(group => {
    const claimResultParts: string[] = [];
    const groupLinePaidTotal = group.lineItems.reduce((sum, item) => sum + parseMoney(item.paidAmount), 0);
    const effectivePaidTotal = group.lineItems.length > 0 ? groupLinePaidTotal : numericTotalPaid;
    const groupResponsibility = formatClaimLevelPatientResponsibility(group.lineItems, scrapedData['patient-responsibility']);
    const groupResponsibilityText = groupResponsibility ? ` ${groupResponsibility}.` : '';
    const groupProcessedDate = group.processedDate || processedDate;
    const groupPaymentRows = paymentRowsForProcessedDate(groupProcessedDate, paymentMappingProcessedDates, paymentRows);
    const groupCheckAmountText = formatCheckAmounts(groupPaymentRows, paymentAmount, effectivePaidTotal);
    const groupCheckNumber = uniqueJoin(groupPaymentRows.map(row => row.number), checkNumber);
    const groupCheckDate = checkDateForProcessedDate(groupProcessedDate, paymentMappingProcessedDates, paymentRows, checkDateFallback);
    if (effectivePaidTotal > 0) {
      claimResultParts.push(`DOS ${serviceDate} Claim processed by ${payerName} on ${groupProcessedDate} under Claim # ${claimNumber}. Payment issued via Check/EFT # ${groupCheckNumber} dated ${groupCheckDate}. Check Amount: ${groupCheckAmountText}.${groupResponsibilityText}`);
    } else {
      claimResultParts.push(`DOS ${serviceDate} Claim processed by ${payerName} on ${groupProcessedDate} under Claim # ${claimNumber}. Claim is Denied under Check #: ${groupCheckNumber} dated ${groupCheckDate}.`);
    }
    const serviceLineNotes = buildServiceLineNotes(group.lineItems, [groupCheckNumber, scrapedData['payment-number'] || '', fields.BotCheckEFTNumber || ''], false);
    if (serviceLineNotes.length > 0) {
      claimResultParts.push(...serviceLineNotes);
    } else if (effectivePaidTotal <= 0) {
      claimResultParts.push(`Service line: Denied for ${fields.BotDenialDescription || 'Service denied'}.`);
    }
    return claimResultParts.join('\n');
  }));

  return fields;
}

function extractValueFromContent(content: string | undefined): string {
  if (!content) return '';
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  return lines.length >= 2 ? lines[1] : lines[0] || '';
}

// ── Return back to the search results screen from a summary page ──────────────
async function goBackToResults(page: Page, claim: ClaimRow, searchMode: 'memberId' | 'name', clientType: string, sendEvent: SendEvent) {
  const log = (msg: string) => sendEvent({ type: 'log', message: msg });
  try {
    const backBtn = page.locator('[data-testid="header-back-button-abyss-button-root"]');
    if (await backBtn.count() > 0 && await backBtn.isVisible()) {
      await log('  🖱️  Clicking header back button to return to search results...');
      await backBtn.click();
      await waitAfterOperation(page, log, 'back to results click');
      await waitForOverlayLoader(page, log, `${SEL.ALL_CLAIM_LINKS}, ${SEL.RESULTS_TBODY}, ${SEL.NO_RESULTS}, ${SEL.RESULTS_HEADING}`);
      await page.waitForSelector(`${SEL.ALL_CLAIM_LINKS}, ${SEL.RESULTS_TBODY}`, { timeout: 10_000 });
      return;
    }
  } catch (err) {
    await log(`  ⚠️  Header back button failed or timed out: ${err}. Trying browser goBack...`);
  }

  try {
    await page.goBack();
    await waitAfterOperation(page, log, 'browser back navigation');
    await waitForOverlayLoader(page, log, `${SEL.ALL_CLAIM_LINKS}, ${SEL.RESULTS_TBODY}, ${SEL.NO_RESULTS}, ${SEL.RESULTS_HEADING}`);
    await page.waitForSelector(`${SEL.ALL_CLAIM_LINKS}, ${SEL.RESULTS_TBODY}`, { timeout: 10_000 });
    return;
  } catch (err) {
    await log(`  ⚠️  Browser goBack failed: ${err}. Re-running search...`);
  }

  await searchClaim(page, claim, searchMode, clientType, sendEvent);
  await waitForOverlayLoader(page, log, `${SEL.ALL_CLAIM_LINKS}, ${SEL.RESULTS_TBODY}, ${SEL.NO_RESULTS}, ${SEL.RESULTS_HEADING}`);
  await page.waitForSelector(`${SEL.ALL_CLAIM_LINKS}, ${SEL.RESULTS_TBODY}`, { timeout: 15_000 });
}

// ── Find matching claims in results ─────────────────────────────────────────────
async function openDualPlanClaimIfPresent(page: Page, log: (msg: string) => Promise<void>): Promise<boolean> {
  const dualPlanSection = page.locator('[data-testid="drg-subtitle"]', { hasText: /Dual Plan Claim Number/i }).first();
  if (!(await dualPlanSection.isVisible({ timeout: 2_000 }).catch(() => false))) {
    return false;
  }

  const dualPlanButton = dualPlanSection.locator('[data-testid="overview-claim-number-button"], button[role="link"]').first();
  if (!(await dualPlanButton.isVisible({ timeout: 2_000 }).catch(() => false))) {
    await log('  Dual Plan Claim Number section was present, but the claim link/button was not visible.');
    return false;
  }

  const label = (await dualPlanButton.innerText({ timeout: 1_000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
  await log(`  Dual Plan Claim Number found${label ? `: ${label}` : ''}. Opening linked claim...`);
  await dualPlanButton.click({ force: true });
  await waitAfterOperation(page, log, 'dual plan claim number click');
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(async () => {
    await log('  Dual Plan linked claim did not go fully network-idle within 15s. Continuing with readiness checks...');
  });
  await waitForClaimDetailLoaders(page, log);
  await waitAfterOperation(page, log, 'dual plan claim detail display');
  await expandAllAccordions(page, log);
  await expandAllClaimLineRows(page, log);
  return true;
}

async function appendDualPlanClaimFieldsIfPresent(options: {
  page: Page;
  claim: ClaimRow;
  payload: Record<string, string>;
  clientType: string;
  targetProcessedDate: string;
  allScrapedFields: Partial<BotFields>[];
  log: (msg: string) => Promise<void>;
}): Promise<void> {
  const { page, claim, payload, clientType, targetProcessedDate, allScrapedFields, log } = options;
  if (!(await openDualPlanClaimIfPresent(page, log))) {
    return;
  }

  const dualScrapedData = await scrapeClaimSummaryPage(page, { targetProcessedDate });
  const dualFields = buildUhcBotFieldsFromScrapedData(dualScrapedData, payload, claim, clientType);
  allScrapedFields.push(dualFields);
  await log(`  Dual Plan linked claim scraped${dualFields.BotProcessedDate ? ` for processed date ${dualFields.BotProcessedDate}` : ''}.`);
}

async function scrapeDualPlanClaimDataIfPresent(options: {
  page: Page;
  targetProcessedDate: string;
  log: (msg: string) => Promise<void>;
}): Promise<Record<string, string> | null> {
  const { page, targetProcessedDate, log } = options;
  if (!(await openDualPlanClaimIfPresent(page, log))) {
    return null;
  }

  return scrapeClaimSummaryPage(page, { targetProcessedDate });
}

async function findMatchingClaim(
  page: Page,
  claim: ClaimRow,
  targetDate: string,
  searchMode: 'memberId' | 'name',
  clientType: string,
  attempt: number,
  sendEvent: SendEvent
): Promise<Partial<BotFields> | { popupError: string } | { dosNotFound: string } | null> {
  const log = (msg: string) => sendEvent({ type: 'log', message: msg });
  const MAX_ATTEMPTS = 2;

  for (let searchAttempt = 1; searchAttempt <= MAX_ATTEMPTS; searchAttempt++) {
    if (searchAttempt > 1) {
      await log(`  🔄  Retrying search after popup (attempt ${searchAttempt}/${MAX_ATTEMPTS})...`);
      await searchClaim(page, claim, searchMode, clientType, sendEvent);
    }

    // Wait for results, "no results" banner, OR the popup close button to appear first.
    // We cannot wait for .abyss-loading-overlay-root to detach first, because if an error popup
    // is displayed, the loading overlay remains visible as its container backdrop and never detaches.
    try {
      await page.waitForSelector(
        `${SEL.RESULTS_HEADING}, ${SEL.RESULTS_TBODY}, ${SEL.ALL_CLAIM_LINKS}, ${SEL.NO_RESULTS}, ${SEL.POPUP_CLOSE}`,
        { timeout: 30_000 }
      );
    } catch (err) {
      await log(`  ⚠️  Timed out waiting for results or popup: ${err}`);
      const systemMessage = await getSystemUnableToRespondMessage(page);
      if (systemMessage) {
        throw new UhcSessionRecoveryError(systemMessage);
      }
      await throwRetryIfHomePage(page, 'waiting for search results');
      throw new UhcRowRetryableError(`Timed out waiting for UHC search results or popup: ${err}`);
    }

    await throwRetryIfHomePage(page, 'search results load');

    const earlySystemMessage = await getSystemUnableToRespondMessage(page);
    if (earlySystemMessage) {
      throw new UhcSessionRecoveryError(earlySystemMessage);
    }

    // Check for popup immediately while the loader may still be present
    const popupMessage = await dismissPopupIfPresent(page, sendEvent);
    if (popupMessage !== null) {
      if (isMemberFoundNoClaimFoundMessage(popupMessage)) {
        await log(`  ❌  Member found, but DOS/claim not found for ${targetDate}. Moving to next row.`);
        return { dosNotFound: popupMessage };
      }

      const lowerMsg = popupMessage.toLowerCase();
      const isPermanent = 
        isMemberLookupNotFoundMessage(popupMessage) ||
        lowerMsg.includes('no claim found') || 
        lowerMsg.includes('please check') || 
        lowerMsg.includes('cannot be found') || 
        lowerMsg.includes('check your entries');

      if (isPermanent) {
        await log(`  ❌  Permanent search error popup: "${popupMessage}". Skipping retries.`);
        return { popupError: popupMessage };
      }

      if (searchAttempt < MAX_ATTEMPTS) {
        await log(`  🔁  Popup dismissed — will retry once.`);
        continue;
      }
      await log(`  ❌  Popup appeared again on attempt ${searchAttempt}. Reporting popup message as row error.`);
      return { popupError: popupMessage };
    }

    // If no popup was present, continue as soon as results/no-results content is visible.
    await waitForOverlayLoader(page, log, `${SEL.ALL_CLAIM_LINKS}, ${SEL.NO_RESULTS}, ${SEL.RESULTS_HEADING}, ${SEL.RESULTS_TBODY}`);

    // No popup — wait for search results table contents to be fully loaded
    try {
      await log('  ⏳  Waiting for search results/claims table to populate...');
      await page.waitForSelector(
        `${SEL.ALL_CLAIM_LINKS}, ${SEL.RESULTS_TBODY}, ${SEL.NO_RESULTS}`,
        { timeout: 15_000 }
      );
      await waitAfterOperation(page, log, 'search results render');
    } catch (err) {
      const systemMessage = await getSystemUnableToRespondMessage(page);
      if (systemMessage) {
        throw new UhcSessionRecoveryError(systemMessage);
      }
      await throwRetryIfHomePage(page, 'waiting for claim links');
      throw new UhcRowRetryableError(`Timed out waiting for UHC claim links or no-results banner: ${err}`);
    }

    const noResults = await page.$(SEL.NO_RESULTS);
    if (noResults) {
      await log('  ℹ️  No results returned for this search.');
      return null;
    }

    // ── Find matching claim links in the DOM ───────────────────────────────────
    const links = await getResultRowClickables(page);
    if (links.length === 0) {
      const rowTexts = await page.locator(`${SEL.RESULTS_TBODY} tr`).evaluateAll(rows =>
        rows.map(row => (row.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean)
      ).catch(() => []);
      if (rowTexts.length > 0) {
        await log(`  Visible UHC result rows did not expose a claim link. Rows: ${rowTexts.slice(0, 3).join(' | ')}`);
      }
    }
    await log(`  📋  Found ${links.length} claim(s). Scanning for target date ${targetDate}...`);

    const matchingClaimIndexes: number[] = [];
    const payloads: Record<string, string>[] = [];
    const hrefs: string[] = [];
    const processedDates: string[] = [];

    for (let i = 0; i < links.length; i++) {
      const href = await links[i].getAttribute('href') ?? '';
      const payload = decodeClaimPayload(href);
      const claimDate = payload.firstServiceDate ?? '';
      const rowText = await getResultRowTextFromLink(links[i]);

      let isMatch = getDateTextVariants(targetDate).includes(claimDate) || textContainsDate(rowText, targetDate);
      if (!isMatch) {
        try {
          const col5 = await page.locator(`td.abyss-table-cell-col-5-row-${i + 1}`).innerText({ timeout: 500 });
          if (textContainsDate(col5.trim(), targetDate)) {
            isMatch = true;
          }
        } catch { /* ignore */ }
      }

      if (isMatch) {
        let processedDate = payload.processedDate || '';
        if (!processedDate) {
          processedDate = await getResultProcessedDateFromLink(links[i]);
        }

        if (!hasSummaryHref(href)) {
          await log(`  UHC result row matched DOS ${targetDate}, but no claim summary href is available. Marking as In Progress from result row.`);
          return await buildInProgressFieldsFromResultRow(page, links[i], claim, processedDate);
        }

        matchingClaimIndexes.push(i);
        payloads.push(payload);
        hrefs.push(href);
        processedDates.push(processedDate);
        await log(`  🎯  Claim Match Found at row index ${i + 1}: Claim ${payload.claimNumber || 'Unknown'} | Status: ${payload.claimStatus || 'Unknown'}`);
      }
    }

    if (matchingClaimIndexes.length === 0) {
      await log(`  ⚠️  No claim matched service date ${targetDate}.`);
      return null;
    }

    const sortedMatchingProcessedDates = uniqueSortedProcessedDates(processedDates);
    let dualPlanTargetProcessedDate = '';

    if (matchingClaimIndexes.length > 1) {
      let latestIndex = 0;
      let latestTimestamp = parseDateTimestamp(processedDates[0]);

      for (let i = 1; i < processedDates.length; i++) {
        const timestamp = parseDateTimestamp(processedDates[i]);
        if (timestamp > latestTimestamp) {
          latestTimestamp = timestamp;
          latestIndex = i;
        }
      }

      dualPlanTargetProcessedDate = sortedMatchingProcessedDates.find(date => parseDateTimestamp(date) !== latestTimestamp) || '';
      await log(`  🎯  ${matchingClaimIndexes.length} matching claims found. Using latest processed date ${processedDates[latestIndex] || 'Unknown'} from claim ${payloads[latestIndex].claimNumber || 'Unknown'}.`);
      if (dualPlanTargetProcessedDate) {
        await log(`  Dual Plan secondary processed date candidate: ${dualPlanTargetProcessedDate}.`);
      }
      matchingClaimIndexes.splice(0, matchingClaimIndexes.length, matchingClaimIndexes[latestIndex]);
      payloads.splice(0, payloads.length, payloads[latestIndex]);
      hrefs.splice(0, hrefs.length, hrefs[latestIndex]);
      processedDates.splice(0, processedDates.length, processedDates[latestIndex]);
    }

    const allScrapedFields: Partial<BotFields>[] = [];

    // Visit summary page for each matched claim
    for (let m = 0; m < matchingClaimIndexes.length; m++) {
      const idx = matchingClaimIndexes[m];
      const p = payloads[m];
      const href = hrefs[m];
      await log(`  🔄  Visiting matching claim ${m + 1}/${matchingClaimIndexes.length}...`);

      // Ensure we are back on results page
      if (m > 0) {
        await goBackToResults(page, claim, searchMode, clientType, sendEvent);
      }

      // Freshly locate the link using its href (most robust against DOM re-rendering) or fallback lazy nth(idx)
      const linkLocator = page.locator(`a[href="${href}"]`);
      
      try {
        if (href && (await linkLocator.count()) > 0) {
          await log(`  🔗  Clicking claim link by href...`);
          await linkLocator.first().click();
          await waitAfterOperation(page, log, 'claim link click');
        } else {
          await log(`  ⚠️  Link with href not found in DOM. Falling back to lazy nth(${idx})...`);
          const currentClickables = await getResultRowClickables(page);
          const clickable = currentClickables[idx];
          if (!clickable) {
            throw new Error(`No clickable claim element found for result row ${idx + 1}.`);
          }
          await clickable.click();
          await waitAfterOperation(page, log, 'claim link click');
        }
      } catch (clickErr) {
        await log(`  ❌  Failed to click claim link: ${clickErr}`);
        throw new Error(`Failed to navigate to claim #${m + 1} details page: ${clickErr}`);
      }

      try {
        await page.waitForURL(/\/summary\//, { timeout: 15_000 });
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(async () => {
          await log('  ⚠️  Claim detail network activity did not go fully idle within 15s. Continuing with page readiness checks...');
        });
      } catch (err) {
        await log(`  ❌  Navigation to claim details timed out: ${err}`);
        await throwRetryIfHomePage(page, 'claim detail navigation');
        throw new UhcRowRetryableError(`Navigation to claim details failed for claim #${m + 1}: ${err}`);
      }

      // Wait for all sub-loaders to complete
      await waitForClaimDetailLoaders(page, log);
      await waitAfterOperation(page, log, 'claim detail display');
      await throwRetryIfHomePage(page, 'claim detail load');

      // Auto-expand accordions
      await expandAllAccordions(page, log);
      await expandAllClaimLineRows(page, log);

      // Capture HTML diagnostics without showing a false error screenshot in the UI.
      try {
        const html = await page.evaluate(() => document.documentElement.outerHTML);
        await sendEvent({ type: 'debug_html', index: -2, rowIndex: claim.rowIndex, attempt, html });
        await log(`  Captured claim detail page DOM HTML for diagnostics.`);
      } catch (diagErr) {
        await log(`  ⚠️  Could not capture details page diagnostics: ${diagErr}`);
      }

      // Scrape Summary Page details
      const scrapedData = await scrapeClaimSummaryPage(page, { targetProcessedDate: processedDates[m] });

      if (dualPlanTargetProcessedDate) {
        const dualScrapedData = await scrapeDualPlanClaimDataIfPresent({
          page,
          targetProcessedDate: dualPlanTargetProcessedDate,
          log,
        });
        if (dualScrapedData) {
          const splitPaymentRows = paymentDetailsMatch(scrapedData, dualScrapedData);
          await log(
            splitPaymentRows
              ? '  Dual Plan check details match by check number and amount. Pairing check rows by processed-date order.'
              : '  Dual Plan check details do not match by check number and amount. Keeping each claim page payment details as-is.'
          );
          allScrapedFields.push(buildUhcBotFieldsFromScrapedData(scrapedData, p, claim, clientType, {
            splitPaymentRowsByProcessedDate: splitPaymentRows,
          }));
          allScrapedFields.push(buildUhcBotFieldsFromScrapedData(dualScrapedData, p, claim, clientType, {
            splitPaymentRowsByProcessedDate: splitPaymentRows,
          }));
          continue;
        }
      }

      const fields: Partial<BotFields> = {};
      fields.BotClaimDetails = formatScrapedDataBlob(scrapedData);

      fields.BotClaimNumber = extractValueFromContent(scrapedData['overview-claim-number'] || scrapedData['cs-claim-number'] || p.claimNumber);
      fields.BotClaimStatus = extractValueFromContent(scrapedData['overview-status'] || scrapedData['overview-adjudication-status'] || p.claimStatus);
      fields.BotPaidAmount = extractValueFromContent(scrapedData['bs-total-paid-content'] || p.totalPaidAmount);
      fields.BotBilledAmount = extractValueFromContent(scrapedData['bs-billed-content'] || p.totalBilledAmount);
      const receivedDate = extractValueFromContent(scrapedData['recieved-date']);
      fields.BotProcessedDate = extractValueFromContent(scrapedData['processed-date'] || p.processedDate);

      // Additional regex and code scrapes
      try {
        const allText = await page.innerText('body');
        const checkMatch = allText.match(/(?:Check|EFT)\s*(?:Number|No\.?)[:\s]+([A-Z0-9\-]+)/i);
        if (checkMatch) fields.BotCheckEFTNumber = checkMatch[1].trim();

        const carcCodes = await page.evaluate(() => {
          return Array.from(new Set(
            Array.from(document.querySelectorAll('[data-testid="expanded-row-carc-codes-text"]'))
              .map(el => el.textContent?.trim())
              .filter(Boolean)
          ));
        });
        const remarkCodes = await page.evaluate(() => {
          return Array.from(new Set(
            Array.from(document.querySelectorAll('[data-testid="expanded-row-remark-codes-text"]'))
              .map(el => el.textContent?.trim())
              .filter(Boolean)
          ));
        });
        if (carcCodes.length > 0) {
          fields.BotDenialReasonCode = carcCodes.join('; ');
        }
        if (remarkCodes.length > 0) fields.BotRemarkCodes = remarkCodes.join('; ');
      } catch (err) {
        await log(`  ⚠️  Error running element/regex scrapes: ${err}`);
      }

      // Build BotClaimResult
      let lineItems: any[] = [];
      try {
        if (scrapedData['line-items-json']) {
          lineItems = JSON.parse(scrapedData['line-items-json']);
        }
      } catch { /* ignore */ }

      const paymentRows = parsePaymentRows(scrapedData['payment-rows-json']);
      if (paymentRows.length > 0) {
        fields.BotCheckEFTNumber = uniqueJoin(paymentRows.map(row => row.number), fields.BotCheckEFTNumber || 'N/A');
      }
      const lineProcessedDates = uniqueSortedProcessedDates(lineItems.map(item => item?.processedDate));
      if (lineProcessedDates.length > 0) {
        fields.BotProcessedDate = lineProcessedDates.join(', ');
      }

      const paidCptCodes = new Set(
        lineItems
          .filter(item => parseMoney(item.paidAmount) > 0)
          .map(item => item.cptCode)
          .filter(Boolean)
      );
      const deniedLineItems = lineItems.filter(item => !paidCptCodes.has(item.cptCode));
      const lineItemCarcs = formatCodesByCpt(deniedLineItems, 'carcs');
      const lineItemRemarks = formatCodesByCpt(deniedLineItems, 'remarks');
      if (lineItemCarcs) {
        fields.BotDenialReasonCode = lineItemCarcs;
        fields.BotDenialDescription = undefined;
      }
      if (lineItemRemarks) fields.BotRemarkCodes = lineItemRemarks;

      const totalPaidStr = fields.BotPaidAmount || '0.00';
      const numericTotalPaid = parseMoney(totalPaidStr);
      
      const checkNumber = fields.BotCheckEFTNumber || uniqueJoin(paymentRows.map(row => row.number), scrapedData['payment-number'] || 'N/A');
      const checkDateFallback = uniqueJoin(paymentRows.map(row => row.issueDate), scrapedData['payment-issue-date'] || fields.BotProcessedDate || 'N/A');
      const paymentAmount = scrapedData['payment-amount'] || fields.BotPaidAmount || '$0.00';
      const payerName = cleanPayerName(scrapedData['payer-name']);
      const processedDate = fields.BotProcessedDate || 'N/A';
      const claimReceivedDate = firstNonEmpty(receivedDate, scrapedData['recieved-date'], 'N/A');
      const claimNumber = fields.BotClaimNumber || 'N/A';
      const serviceDate = claim.serviceDate;
      const isMedRevenu = normalizeOptionText(clientType) === 'medrevenu';
      const claimServiceCode = getClaimServiceCode(claim);
      const medRevenuLineItems = isMedRevenu ? filterLineItemsByServiceCode(lineItems, claimServiceCode) : lineItems;
      const medRevenuLinePaidTotal = medRevenuLineItems.reduce((sum, item) => sum + parseMoney(item.paidAmount), 0);
      const medRevenuPaidAmountText = formatMoney(String(medRevenuLinePaidTotal));
      const adjudicationLineItems = isMedRevenu ? medRevenuLineItems : lineItems;
      const isInProcess = scrapedData['claim-in-process'] === 'true' && paymentRows.length === 0 && !hasLineAdjudicationDetails(adjudicationLineItems);

      if (isInProcess) {
        fields.BotClaimResult = `DOS ${serviceDate} Claim received on ${claimReceivedDate} is in process by ${payerName} on Claim # ${claimNumber}.`;
        allScrapedFields.push(fields);
        await log(`  ℹ️  Scraped details for claim #${m + 1} (${fields.BotClaimNumber}): length ${fields.BotClaimDetails.length}`);
        await appendDualPlanClaimFieldsIfPresent({
          page,
          claim,
          payload: p,
          clientType,
          targetProcessedDate: dualPlanTargetProcessedDate,
          allScrapedFields,
          log,
        });
        continue;
      }

      if (isMedRevenu) {
        fields.BotPaidAmount = medRevenuPaidAmountText;
        const medRevenuHasPaidLine = medRevenuLinePaidTotal > 0;
        const medRevenuDeniedLineItems = medRevenuHasPaidLine ? [] : medRevenuLineItems;
        const medRevenuCarcs = formatCodesByCpt(medRevenuDeniedLineItems, 'carcs');
        const medRevenuRemarks = formatCodesByCpt(medRevenuDeniedLineItems, 'remarks');
        fields.BotDenialReasonCode = medRevenuCarcs || undefined;
        fields.BotRemarkCodes = medRevenuRemarks || undefined;

        const medRevenuGroups = groupLineItemsByProcessedDate(medRevenuLineItems, processedDate);
        fields.BotClaimResult = joinClaimResultSections(medRevenuGroups.map(group => {
          const groupLinePaidTotal = group.lineItems.reduce((sum, item) => sum + parseMoney(item.paidAmount), 0);
          const groupPaidAmountText = formatMoney(String(groupLinePaidTotal));
          const groupHasPaidLine = groupLinePaidTotal > 0;
          const groupDeniedLineItems = groupHasPaidLine ? [] : group.lineItems;
          const groupDenialReasonText = formatMedRevenuDenialReason(groupDeniedLineItems, fields.BotDenialReasonCode || fields.BotDenialDescription);
          const groupProcessedDate = group.processedDate || processedDate;
          const groupPaymentRows = paymentRowsForProcessedDate(groupProcessedDate, lineProcessedDates, paymentRows);
          const groupCheckAmountText = formatCheckAmounts(groupPaymentRows, paymentAmount, groupLinePaidTotal);
          const groupCheckNumber = uniqueJoin(groupPaymentRows.map(row => row.number), checkNumber);
          const groupCheckDate = checkDateForProcessedDate(groupProcessedDate, lineProcessedDates, paymentRows, checkDateFallback);

          if (groupLinePaidTotal > 0) {
            return `DOS ${serviceDate}: Checked IEHP portal Claim Received on ${claimReceivedDate} and Processed on ${groupProcessedDate}. Paid on ${groupCheckDate} paid amount ${groupPaidAmountText} EFT/Check # ${groupCheckNumber}. Check Amount: ${groupCheckAmountText}. Claim #: ${claimNumber}`;
          }

          return `DOS ${serviceDate}: Checked IEHP portal Claim Received on ${claimReceivedDate} and Processed on ${groupProcessedDate}. Denied on ${groupCheckDate} denial reason ${groupDenialReasonText} EFT/Check # ${groupCheckNumber}. Check Amount: ${groupCheckAmountText}. Claim #: ${claimNumber}`;
        }));
        allScrapedFields.push(fields);
        await log(`  ℹ️  Scraped details for claim #${m + 1} (${fields.BotClaimNumber}): length ${fields.BotClaimDetails.length}`);
        await appendDualPlanClaimFieldsIfPresent({
          page,
          claim,
          payload: p,
          clientType,
          targetProcessedDate: dualPlanTargetProcessedDate,
          allScrapedFields,
          log,
        });
        continue;
      }

      const genericGroups = groupLineItemsByProcessedDate(lineItems, processedDate);
      fields.BotClaimResult = joinClaimResultSections(genericGroups.map(group => {
        const groupClaimResultParts: string[] = [];
        const groupLinePaidTotal = group.lineItems.reduce((sum, item) => sum + parseMoney(item.paidAmount), 0);
        const effectivePaidTotal = group.lineItems.length > 0 ? groupLinePaidTotal : numericTotalPaid;
        const groupResponsibility = formatClaimLevelPatientResponsibility(group.lineItems, scrapedData['patient-responsibility']);
        const groupResponsibilityText = groupResponsibility ? ` ${groupResponsibility}.` : '';
        const groupProcessedDate = group.processedDate || processedDate;
        const groupPaymentRows = paymentRowsForProcessedDate(groupProcessedDate, lineProcessedDates, paymentRows);
        const groupCheckAmountText = formatCheckAmounts(groupPaymentRows, paymentAmount, effectivePaidTotal);
        const groupCheckNumber = uniqueJoin(groupPaymentRows.map(row => row.number), checkNumber);
        const groupCheckDate = checkDateForProcessedDate(groupProcessedDate, lineProcessedDates, paymentRows, checkDateFallback);

        if (effectivePaidTotal > 0) {
          groupClaimResultParts.push(`DOS ${serviceDate} Claim processed by ${payerName} on ${groupProcessedDate} under Claim # ${claimNumber}. Payment issued via Check/EFT # ${groupCheckNumber} dated ${groupCheckDate}. Check Amount: ${groupCheckAmountText}.${groupResponsibilityText}`);
        } else {
          groupClaimResultParts.push(`DOS ${serviceDate} Claim processed by ${payerName} on ${groupProcessedDate} under Claim # ${claimNumber}. Claim is Denied under Check #: ${groupCheckNumber} dated ${groupCheckDate}.`);
        }

        const serviceLineNotes = buildServiceLineNotes(group.lineItems, [groupCheckNumber, scrapedData['payment-number'] || '', fields.BotCheckEFTNumber || ''], false);
        if (serviceLineNotes.length > 0) {
          groupClaimResultParts.push(...serviceLineNotes);
        } else if (effectivePaidTotal <= 0) {
          groupClaimResultParts.push(`Service line: Denied for ${fields.BotDenialDescription || 'Service denied'}.`);
        }

        return groupClaimResultParts.join('\n');
      }));
      allScrapedFields.push(fields);
      await log(`  ℹ️  Scraped details for claim #${m + 1} (${fields.BotClaimNumber}): length ${fields.BotClaimDetails.length}`);
      await appendDualPlanClaimFieldsIfPresent({
        page,
        claim,
        payload: p,
        clientType,
        targetProcessedDate: dualPlanTargetProcessedDate,
        allScrapedFields,
        log,
      });
    }

    // Combine results
    const combinedFields: Partial<BotFields> = {};
    if (allScrapedFields.length === 1) {
      Object.assign(combinedFields, allScrapedFields[0]);
    } else if (allScrapedFields.length > 1) {
      combinedFields.BotClaimNumber = allScrapedFields.map(f => f.BotClaimNumber).filter(Boolean).join(', ');
      combinedFields.BotClaimStatus = allScrapedFields.map(f => f.BotClaimStatus).filter(Boolean).join(', ');
      combinedFields.BotPaidAmount = allScrapedFields.map(f => f.BotPaidAmount).filter(Boolean).join(', ');
      combinedFields.BotBilledAmount = allScrapedFields.map(f => f.BotBilledAmount).filter(Boolean).join(', ');
      combinedFields.BotCheckEFTNumber = allScrapedFields.map(f => f.BotCheckEFTNumber).filter(Boolean).join(', ');
      combinedFields.BotDenialReasonCode = allScrapedFields.map(f => f.BotDenialReasonCode).filter(Boolean).join(', ');
      combinedFields.BotRemarkCodes = allScrapedFields.map(f => f.BotRemarkCodes).filter(Boolean).join(', ');
      combinedFields.BotProcessedDate = uniqueSortedProcessedDates(
        allScrapedFields.flatMap(f => String(f.BotProcessedDate || '').split(','))
      ).join(', ');

      combinedFields.BotClaimDetails = allScrapedFields.map((f, i) => {
        const claimNum = f.BotClaimNumber || 'Unknown';
        return `=== Claim #${i + 1} (${claimNum}) ===\n${f.BotClaimDetails}`;
      }).join(CLAIM_RESULT_SECTION_SEPARATOR);

      combinedFields.BotClaimResult = joinClaimResultSections(allScrapedFields.map(f => f.BotClaimResult || ''));
      
      await log(`  ℹ️  Combined BotClaimDetails for ${allScrapedFields.length} claims: length ${combinedFields.BotClaimDetails.length}`);
    }

    return combinedFields;
  }

  return null;
}

// ── Process a single row ──────────────────────────────────────────────────────
async function processRow(
  page: Page,
  claim: ClaimRow,
  arrayIndex: number,   // 0-based index for workbook update
  rowNum: number,       // 1-based (i + startIndex + 1) for logging
  total: number,
  clientType: string,
  attempt: number,
  sendEvent: SendEvent
): Promise<BotFields> {
  const log = (msg: string) => sendEvent({ type: 'log', message: msg });

  await log(`\n📄 Row ${rowNum}/${total} — Subscriber: ${claim.subscriberNo} | DOB: ${claim.patientDOB} | Date: ${claim.serviceDate}`);

  try {
    let searchMode: 'memberId' | 'name' = 'memberId';
    if (await isUhcHomePage(page)) {
      await log('  UHC is on the home page before row search. Returning to Claim Status search...');
      await navigateToClaimSearch(page, sendEvent);
    }
    await searchClaim(page, claim, searchMode, clientType, sendEvent);
    let match = await findMatchingClaim(page, claim, claim.serviceDate, searchMode, clientType, attempt, sendEvent);

    if (match && 'dosNotFound' in match) {
      const message = `DOS not found for ${claim.serviceDate}. ${match.dosNotFound}`;
      await log(`  ❌  Row ${rowNum}: DOS not found — ${claim.serviceDate}`);
      return {
        BotClaimResult: `DOS ${claim.serviceDate}: DOS not found.`,
        BotStatus: 'Error',
        BotStatusError: message,
        BotUpdateTime: new Date().toISOString(),
      };
    }

    // Check if we should retry using patient name & DOB
    const memberNotFoundPopupMessage = match && 'popupError' in match && isMemberLookupNotFoundMessage(match.popupError)
      ? match.popupError
      : '';
    
    const noClaimMatched = !match;

    if (memberNotFoundPopupMessage) {
      await log(`  ❌  Row ${rowNum}: Member lookup failed — ${memberNotFoundPopupMessage}`);
    } else if (noClaimMatched) {
      const nameParts = getPatientNameParts(claim);
      const hasName = !!(nameParts.firstName || nameParts.lastName);

      if (hasName) {
        await log(`  🔄  No claim found using Member ID. Retrying using Patient Name & DOB...`);
        searchMode = 'name';
        
        // Clean navigation transition
        if (noClaimMatched) {
          await navigateToClaimSearch(page, sendEvent);
        } else if (match && 'popupError' in match) {
          await navigateToClaimSearch(page, sendEvent);
        }

        await searchClaim(page, claim, searchMode, clientType, sendEvent);
        match = await findMatchingClaim(page, claim, claim.serviceDate, searchMode, clientType, attempt, sendEvent);
        if (match && 'dosNotFound' in match) {
          const message = `DOS not found for ${claim.serviceDate}. ${match.dosNotFound}`;
          await log(`  ❌  Row ${rowNum}: DOS not found — ${claim.serviceDate}`);
          return {
            BotClaimResult: `DOS ${claim.serviceDate}: DOS not found.`,
            BotStatus: 'Error',
            BotStatusError: message,
            BotUpdateTime: new Date().toISOString(),
          };
        }
      } else {
        await log(`  ℹ️  No claim found using Member ID. Patient Name column is empty/missing, skipping name search retry.`);
      }
    }

    // Popup appeared twice — surface its message as a row error
    if (match && 'popupError' in match) {
      const botFields: BotFields = {
        BotClaimStatus: 'Failed',
        BotClaimResult: match.popupError,
        BotStatus:      'Error',
        BotStatusError: match.popupError,
        BotUpdateTime:  new Date().toISOString(),
      };
      await log(`  ❌  Row ${rowNum}: Popup error — ${match.popupError}`);
      await navigateToClaimSearch(page, sendEvent);
      return botFields;
    }

    if (!match) {
      const botFields: BotFields = {
        BotStatus:      'Skipped',
        BotStatusError: `No claim found for Subscriber ${claim.subscriberNo} / Name ${claim.patientName || ''} on ${claim.serviceDate}`,
        BotUpdateTime:  new Date().toISOString(),
      };
      await log(`  ⏭️  Row ${rowNum}: Skipped — no match.`);
      return botFields;
    }

    const botFields: BotFields = {
      BotClaimNumber:   match.BotClaimNumber ?? '',
      BotClaimStatus:   match.BotClaimStatus ?? '',
      BotPaidAmount:    match.BotPaidAmount ?? '',
      BotBilledAmount:  match.BotBilledAmount ?? '',
      BotProcessedDate: match.BotProcessedDate ?? '',
      BotUpdateTime:    new Date().toISOString(),
      BotStatus:        'Success',
      BotStatusError:   '',
      ...match,
    };

    await log(`  ✅  Row ${rowNum}: Success — Claim ${botFields.BotClaimNumber} | Status: ${botFields.BotClaimStatus} | Paid: ${botFields.BotPaidAmount}`);

    // Navigate back for next row
    await navigateToClaimSearch(page, sendEvent);
    return botFields;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (isUhcSessionRecoveryError(err)) {
      await log(`  UHC session recovery needed for Row ${rowNum}: ${msg}`);
      throw err;
    }
    if (isUhcRowRetryableError(err)) {
      await log(`  UHC row retry needed for Row ${rowNum}: ${msg}`);
      throw err;
    }
    await log(`  ❌  Row ${rowNum}: Failed — ${msg}`);

    // Capture screenshot + HTML for debugging
    try {
      const ss = await page.screenshot({ type: 'jpeg', quality: 60 });
      await sendEvent({ type: 'error_screenshot', index: arrayIndex, rowIndex: claim.rowIndex, attempt, image: ss.toString('base64') });
      await page.waitForTimeout(1000);
      const html = await page.evaluate(() => document.documentElement.outerHTML);
      await sendEvent({ type: 'debug_html', index: arrayIndex, rowIndex: claim.rowIndex, attempt, html });
    } catch (diagErr) {
      await log(`  ⚠️  Could not capture error diagnostics: ${diagErr}`);
    }

    if (err instanceof Error) {
      (err as any).diagnosticsCaptured = true;
    }

    const isTerminal = 
      msg.includes('closed') || 
      msg.includes('Protocol error') || 
      msg.includes('browser has been closed') ||
      msg.includes('context has been closed') ||
      msg.includes('Target page, context or browser has been closed');

    if (isTerminal) {
      await log(`  🚨  Terminal error (browser closed/destroyed) detected in Row ${rowNum}. Terminating execution.`);
      throw err;
    }

    try { await navigateToClaimSearch(page, sendEvent); } catch { /* ignore recovery failure */ }

    return {
      BotStatus:      'Error',
      BotStatusError: msg,
      BotUpdateTime:  new Date().toISOString(),
    };
  }
}

// ── Main exported automation function ─────────────────────────────────────────
export interface AutomationOptions {
  username: string;
  password: string;
  baseUrl: string;
  claims: ClaimRow[];
  startIndex: number;
  browserType?: string; // 'chrome' | 'firefox'
  clientType?: string;
  corporateTaxIdOwner?: string;
  careProvider?: string;
  providerOptionsOnly?: boolean;
  onProviderOptions?: (options: ProviderOptions) => void | Promise<void>;
  requestOtp?: () => Promise<string>;
  requestProviderSelection?: (options: ProviderOptions, stage: 'corporate' | 'care') => Promise<ProviderSelection>;
  attempt?: number;
  batchSize?: number;
  maxExecutionMs?: number;
  sendEvent: SendEvent;
}

export async function runAutomation(opts: AutomationOptions): Promise<void> {
  const {
    username,
    password,
    baseUrl,
    claims,
    startIndex,
    browserType    = 'chrome',
    clientType     = 'minimax',
    corporateTaxIdOwner = '',
    careProvider   = '',
    providerOptionsOnly = false,
    onProviderOptions,
    requestOtp,
    requestProviderSelection,
    attempt        = 1,
    batchSize      = 50,
    maxExecutionMs = Number.POSITIVE_INFINITY,
    sendEvent,
  } = opts;

  const log = (msg: string) => sendEvent({ type: 'log', message: msg });

  // Read headless from environment variable, defaulting to false for local desktop, and true for server environments (Render/Vercel/Netlify)
  const isRender = process.env.RENDER === 'true' || !!process.env.RENDER;
  const isServerless = 
    process.env.VERCEL === '1' || 
    !!process.env.VERCEL_ENV || 
    process.env.NETLIFY === 'true' || 
    !!process.env.NETLIFY || 
    !!process.env.LAMBDA_TASK_ROOT;

  const isProduction = process.env.NODE_ENV === 'production';
  const forceHeadless = isServerless || isRender;
  const headless = forceHeadless ? true : (process.env.HEADLESS !== undefined 
    ? process.env.HEADLESS === 'true' 
    : isProduction);
  const wsEndpoint = process.env.BROWSERLESS_CONNECT_URL || process.env.PLAYWRIGHT_WS_ENDPOINT;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let activeCorporateTaxIdOwner = corporateTaxIdOwner;
  let activeCareProvider = careProvider;

  try {
    await log(`  ℹ️  Environment info: Serverless=${isServerless} | Render=${isRender} | Production=${isProduction} | Headless=${headless}`);

    if (wsEndpoint) {
      await log(`🚀 Connecting to remote browser at ${wsEndpoint}...`);
      browser = await playwrightChromium.connectOverCDP(wsEndpoint);
      await log(`✅ Connected to remote browser.`);
    } else if (isServerless) {
      if (browserType === 'firefox') {
        await log(`⚠️ Firefox requested, but serverless environments only support @sparticuz/chromium. Falling back to @sparticuz/chromium...`);
      }
      await log(`🚀 Launching @sparticuz/chromium for serverless environment...`);
      browser = await playwrightChromium.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: true,
      });
      await log(`✅ @sparticuz/chromium launched successfully.`);
    } else if (browserType === 'firefox') {
      await log(`🚀 Launching Firefox locally (headless=${headless})...`);
      browser = await playwrightFirefox.launch({
        headless,
      });
      await log(`✅ Local Firefox launched successfully.`);
    } else {
      await log(`🚀 Launching Chrome locally (headless=${headless}) — Akamai mode: real keystrokes...`);
      try {
        browser = await playwrightChromium.launch({
          headless,
          channel: 'chromium',
          args: [
            // Needed for Akamai canvas / WebGL fingerprinting to produce real values
            '--disable-blink-features=AutomationControlled',
            '--use-gl=desktop',
            '--enable-webgl',
          ],
        });
      } catch (launchErr: any) {
        const msg = String(launchErr.message || launchErr);
        if (msg.includes("Executable doesn't exist") || msg.includes("Looks like Playwright was just installed")) {
          await log(`⚠️ Playwright browser not found. Running self-healing installer: npx playwright-core install chromium...`);
          try {
            const { execSync } = require('child_process');
            const env = { ...process.env };
            if (isRender) {
              env.PLAYWRIGHT_BROWSERS_PATH = '0';
            }
            execSync('npx playwright-core install chromium', { stdio: 'inherit', env });
            await log(`✅ Playwright browser installed successfully. Retrying launch...`);
            
            if (isRender) {
              process.env.PLAYWRIGHT_BROWSERS_PATH = '0';
            }
            browser = await playwrightChromium.launch({
              headless,
              channel: 'chromium',
              args: [
                '--disable-blink-features=AutomationControlled',
                '--use-gl=desktop',
                '--enable-webgl',
              ],
            });
          } catch (installErr) {
            await log(`❌ Self-healing browser installation failed: ${installErr}`);
            throw launchErr;
          }
        } else {
          throw launchErr;
        }
      }
      await log(`✅ Local Chrome launched successfully.`);
    }

    const browserContextOptions = {
      viewport: { width: 1440, height: 900 },
      userAgent: linuxChromeUserAgent(browser.version()),
    };

    context = await browser.newContext(browserContextOptions);
    await log(`✅ Browser context created.`);
    page = await context.newPage();
    page.setDefaultTimeout(30_000);
    await log(`✅ Browser page created.`);

    // ── Akamai sensor debug: intercept the authenticate call to log headers ──
    // This lets us see the wu44b0puoj-* sensor headers Akamai's JS generates.
    // Remove once login is stable.
    await page.route('**/api/v1/auth/authenticate', async (route) => {
      const req     = route.request();
      const headers = req.headers();
      await log('  🔍 [Akamai] Auth request headers: ' + Object.keys(headers).join(', '));
      const akamaiKeys = Object.keys(headers).filter(k => k.startsWith('wu44b0puoj') || k.includes('akamai') || k.includes('sensor'));
      if (akamaiKeys.length > 0) {
        await log('  🔍 [Akamai] Sensor headers present: ' + akamaiKeys.join(', '));
      } else {
        await log('  ⚠️  [Akamai] No sensor headers found — Akamai JS may not have initialised yet.');
      }
      await route.continue();
    });

    const attachAkamaiRoute = async (targetPage: Page) => {
      await targetPage.route('**/api/v1/auth/authenticate', async (route) => {
        const req = route.request();
        const headers = req.headers();
        await log('  [Akamai] Auth request headers: ' + Object.keys(headers).join(', '));
        const akamaiKeys = Object.keys(headers).filter(k => k.startsWith('wu44b0puoj') || k.includes('akamai') || k.includes('sensor'));
        if (akamaiKeys.length > 0) {
          await log('  [Akamai] Sensor headers present: ' + akamaiKeys.join(', '));
        } else {
          await log('  [Akamai] No sensor headers found. Akamai JS may not have initialised yet.');
        }
        await route.continue();
      });
    };

    const restartSessionAndReturnToSearch = async (reason: string, diagnosticRowIndex: number): Promise<Page> => {
      if (!browser) throw new Error('Cannot recover UHC session because browser is not available.');
      await log(`  UHC recovery: ${reason}`);
      await log('  Closing current browser context and opening a fresh test browser page...');
      await context?.close().catch(() => {});
      context = await browser.newContext(browserContextOptions);
      page = await context.newPage();
      page.setDefaultTimeout(30_000);
      await attachAkamaiRoute(page);
      await login(page, username, password, baseUrl, diagnosticRowIndex, attempt, clientType, requestOtp, sendEvent);
      await configureProviderSelection(page, {
        corporateTaxIdOwner: activeCorporateTaxIdOwner,
        careProvider: activeCareProvider,
      }, log);
      await navigateToClaimSearch(page, sendEvent);
      return page;
    };

    const startRowIndex = claims[startIndex]?.rowIndex ?? 2;
    await login(page, username, password, baseUrl, startRowIndex, attempt, clientType, requestOtp, sendEvent);
    if (providerOptionsOnly) {
      const providerOptions = await scrapeProviderOptions(page, log);
      await onProviderOptions?.(providerOptions);
      await sendEvent({ type: 'done', completed: startIndex, total: claims.length });
      return;
    }

    if (requestProviderSelection) {
      const corporateTaxIdOwners = await scrapeCorporateTaxIdOwners(page, log);
      const corporateSelection = await requestProviderSelection({ corporateTaxIdOwners, careProviders: [] }, 'corporate');
      const selectedCorporateTaxIdOwner = corporateSelection.corporateTaxIdOwner || corporateTaxIdOwner;
      activeCorporateTaxIdOwner = selectedCorporateTaxIdOwner;
      const careProviders = selectedCorporateTaxIdOwner
        ? await selectCorporateAndFetchCareProviders(page, selectedCorporateTaxIdOwner, log)
        : await scrapeCareProviders(page, log);
      const careSelection = await requestProviderSelection(
        { corporateTaxIdOwners: selectedCorporateTaxIdOwner ? [selectedCorporateTaxIdOwner] : corporateTaxIdOwners, careProviders },
        'care'
      );
      if (selectedCorporateTaxIdOwner) {
        activeCareProvider = careSelection.careProvider || careProvider;
        await selectCareProviderAndSaveOpenDrawer(page, activeCareProvider, log);
      } else {
        activeCareProvider = careSelection.careProvider || careProvider;
        await configureProviderSelection(page, { careProvider: activeCareProvider }, log);
      }
    } else {
      await configureProviderSelection(page, { corporateTaxIdOwner, careProvider }, log);
    }
    await navigateToClaimSearch(page, sendEvent);

    await log(`\n📊 Processing ${claims.length} rows. Starting from index ${startIndex}. Batch size: ${batchSize}.`);
    await sendEvent({ type: 'progress', completed: startIndex, total: claims.length });

    let processedInBatch = 0;
    let i = startIndex;

    for (; i < claims.length; i++) {
      if (processedInBatch >= batchSize) {
        await log(`⏸️  Batch complete (${processedInBatch} rows). Auto-resuming from row ${i + 1}...`);
        break;
      }

      let fields: BotFields;
      try {
        fields = await processRow(page, claims[i], i, i + 1, claims.length, clientType, attempt, sendEvent);
      } catch (err) {
        if (isUhcSessionRecoveryError(err)) {
          await log(`  UHC returned a temporary system error. Re-opening browser and retrying row ${i + 1} once...`);
          page = await restartSessionAndReturnToSearch(err.message, claims[i].rowIndex ?? i + 2);
        } else if (isUhcRowRetryableError(err)) {
          await log(`  UHC retryable row condition: ${err.message}. Re-searching row ${i + 1} once...`);
          await navigateToClaimSearch(page, sendEvent).catch(async (navErr) => {
            await log(`  Could not return to claim search before retry: ${navErr}. Re-opening browser session...`);
            page = await restartSessionAndReturnToSearch(err.message, claims[i].rowIndex ?? i + 2);
          });
        } else {
          throw err;
        }
        fields = await processRow(page, claims[i], i, i + 1, claims.length, clientType, attempt, sendEvent);
      }

      await log(`  ℹ️  Sending row_update for row ${claims[i].rowIndex}: keys=[${Object.keys(fields).join(', ')}]`);
      if (fields.BotClaimDetails) {
        await log(`  ℹ️  Sending BotClaimDetails: length ${fields.BotClaimDetails.length}`);
      } else {
        await log(`  ⚠️  Sending BotClaimDetails: EMPTY OR UNDEFINED`);
      }

      await sendEvent({
        type:     'row_update',
        index:    i,           // 0-based for workbook lookup
        rowIndex: claims[i].rowIndex, // 1-based Excel row
        update:   fields,
      });

      await sendEvent({
        type:      'progress',
        completed: i + 1,
        total:     claims.length,
      });

      processedInBatch++;
    }

    await log(`\n✅ Batch finished. Processed ${processedInBatch} row(s) this batch.`);
    await sendEvent({ type: 'done', completed: startIndex, total: claims.length });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await log(`❌ Automation run error: ${msg}`);

    // Capture screenshot + HTML if page is still open and we haven't already captured diagnostics
    if (!(err as any)?.diagnosticsCaptured && page && !page.isClosed()) {
      try {
        const startRowIndex = claims[startIndex]?.rowIndex ?? 2;
        const ss = await page.screenshot({ type: 'jpeg', quality: 60 });
        await sendEvent({ type: 'error_screenshot', index: -1, rowIndex: startRowIndex, attempt, image: ss.toString('base64') });
        await page.waitForTimeout(1000);
        const html = await page.evaluate(() => document.documentElement.outerHTML);
        await sendEvent({ type: 'debug_html', index: -1, rowIndex: startRowIndex, attempt, html });
        (err as any).diagnosticsCaptured = true;
      } catch (diagErr) {
        await log(`⚠️ Could not capture diagnostic logs on crash: ${diagErr}`);
      }
    }
    throw err;
  } finally {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
