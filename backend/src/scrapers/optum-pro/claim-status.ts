import fs from "node:fs/promises";
import path from "node:path";
import type { Frame, Page } from "playwright-core";
import * as XLSX from "xlsx";
import { getJobDataPath } from "@/backend/src/core/storage";
import type { ScraperContext } from "../../workflows/claim-status/types";
import type { OptumProInputRow } from "./input";

type StageLog = (level: "info" | "warn" | "error", stage: string, message: string, currentPage?: Page) => Promise<void>;
type RowTimingLog = (label: string, startedAt: number) => Promise<void>;
type CancellationCheck = () => void;

type OptumProSearchResult = {
  input: OptumProInputRow;
  rowNumber: number;
  medicalGroupName: string;
  patient: string;
  dos: string;
  cpt: string;
  memberId: string;
  matchedPatient: string;
  matchedGroup: string;
  claimNumber: string;
  claimReceivedDate: string;
  processedDate: string;
  serviceCode: string;
  billedAmount: string;
  planAllowedAmount: string;
  patientResponsibility: string;
  withholdAmount: string;
  deniedAmount: string;
  paidAmount: string;
  lineStatus: string;
  explanationCode: string;
  explanationDescription: string;
  copayAmount: string;
  coinsuranceAmount: string;
  deductibleAmount: string;
  paymentMode: string;
  paymentType: string;
  eftNumber: string;
  eftAmount: string;
  paymentDate: string;
  paymentId: string;
  paymentName: string;
  payeeName: string;
  resultSummary: string;
  status: string;
  notes: string;
};

type PatientSelectionMode = "loose" | "blank-subscriber";

type PatientDropdownRow = {
  index: number;
  text: string;
  subscriberId: string;
  patientName: string;
};

type PatientSelection = {
  text: string;
  allowBlankSubscriberFallback: boolean;
};

type ClaimResultCandidate = {
  index: number;
  score: number;
  text: string;
  claimNumber: string;
  resultStatus: string;
};

type OptumProPartialJobMetadata = {
  totalRows: number;
  processedRows: number;
  successfulRows: number;
  failedRows: number;
  stopped: boolean;
  partialOutputAvailable: boolean;
};

class OptumProStopRequestedError extends Error {
  constructor(message = "Optum Pro stop requested.") {
    super(message);
    this.name = "OptumProStopRequestedError";
  }
}

const CLAIM_SEARCH_PATIENT_SELECTOR = "input#patient-details, input[placeholder*='subscriber ID' i], input[placeholder*='patient name' i], input[placeholder*='DOB' i], input[placeholder*='Date of Birth' i]";
const CLAIM_SEARCH_MEDICAL_GROUP_SELECTOR = "input[cmdk-input], input[placeholder*='medical group' i]";
const CLAIM_SEARCH_DATE_SELECTOR = "input[placeholder*='MM/DD/YYYY']:visible";
const CLAIM_SEARCH_ACTION_SELECTOR = "button:has-text('Search'):visible, button:has-text('Clear search'):visible";
const CLAIM_SEARCH_READY_TIMEOUT_MS = 45000;
const FAST_CLAIM_SEARCH_READY_TIMEOUT_MS = 1500;
const CLEAR_FORM_CLICK_TIMEOUT_MS = 2000;
const CLEAR_FORM_READY_TIMEOUT_MS = 1000;
const INITIAL_FEEDBACK_DISMISS_CHECKED = new WeakSet<Page>();
const CLAIM_DETAILS_PAGE_SIGNALS = [
  "text=/Claim details/i",
  "text=/Claim information/i",
  "text=/Claim received date/i",
  "text=/Processed date/i",
  "text=/Payment mode/i",
  "text=/Payment information/i",
  "text=/Payment details/i",
  "text=/Billing information/i",
  "text=/Service and procedure details/i",
];

function elapsedSeconds(startedAt: number): string {
  return ((Date.now() - startedAt) / 1000).toFixed(1);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeLetters(value: string): string {
  return value.toLowerCase().replace(/[^a-z]+/g, "");
}

function normalizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z]+/g, " ").trim().replace(/\s+/g, " ");
}

function leadingThreeLettersStripped(value: string): string {
  return /^[A-Za-z]{3}/.test(value) ? value.slice(3) : value;
}

function normalizeMedicalGroupForCompare(value: string): string {
  return value
    .toLowerCase()
    .replace(/[.,'"()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildMedicalGroupSearch(value: string): string {
  return (value.trim().split(/\s+/)[0] || "").replace(/[.,'"()\-]/g, "");
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!match) return trimmed;
  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${month}/${day}/${year}`;
}

function downloadableWorkbookEvent(filename: string, content: Buffer): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: content.toString("base64"),
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };
}

function isTimeoutError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out/i.test(message);
}

function isFrameDetachedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /frame was detached/i.test(message);
}

/**
 * Optum recently moved the entire Claims experience (the "Select your CDO"
 * modal, Claim Search form, results table, and claim details) into a child
 * iframe (src contains "claims-ui") that talks to the OCNP shell via
 * postMessage. Playwright's `page.locator()` / `page.evaluate()` only search
 * the top-level frame by default, so every locator in this file would
 * silently find nothing once that iframe is in play — which is exactly why
 * automation was hanging on the Subscriber ID field despite the CDO modal
 * being visible on screen.
 *
 * Rather than threading a `Frame` type through every function in this file
 * (~60 call sites), `createClaimsScope` builds a Proxy that looks like a
 * `Page` to the rest of the code: locator/getByText/evaluate/waitForFunction/
 * waitForTimeout/url all delegate to the resolved claims-ui `Frame` (so they
 * search the right DOM), while `keyboard`/`mouse` delegate to the real
 * top-level `Page` (since those dispatch OS-level input events that work
 * regardless of which frame currently has focus). Everything downstream
 * keeps using `page.locator(...)` etc. exactly as before and just works.
 */
const CLAIMS_SCOPE_ROOT_PAGE = Symbol("optumProClaimsScopeRootPage");

/**
 * Optum's OCNP shell doesn't just mount the `claims-ui` iframe once and leave
 * it alone: after the CDO navigation context is posted into it
 * (`SET_NAVIGATION_CONTEXT`), the shell frequently tears the iframe down and
 * re-navigates it to the same URL, which aborts every in-flight chunk request
 * for the old document ("net::ERR_ABORTED") and detaches the `Frame` object
 * Playwright had already handed back. Grabbing the *first* frame whose URL
 * matches "claims-ui" and immediately returning it is therefore a race: the
 * frame can be replaced a few hundred ms later, and every locator built on
 * top of the stale `Frame` then fails with "Frame was detached".
 *
 * To avoid handing back a frame that's mid-teardown, this waits for the
 * frame to be attached AND to have reached "load" (not just
 * "domcontentloaded", which can fire right before the abort/remount). If the
 * frame detaches while we're waiting on it, we don't throw — we just loop
 * around and pick up whatever frame replaces it.
 */
async function resolveClaimsFrame(rootPage: Page, stageLog?: StageLog, timeout = 30000): Promise<Frame> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const claimsFrame = rootPage.frames().find((candidate) => /claims-ui/i.test(candidate.url()) && !candidate.isDetached());
    if (claimsFrame) {
      const settled = await claimsFrame
        .waitForLoadState("load", { timeout: 5000 })
        .then(() => !claimsFrame.isDetached())
        .catch(() => false);
      if (settled) {
        await stageLog?.("info", "claim-navigation", `Optum Pro claims-ui iframe settled at ${claimsFrame.url()}.`);
        return claimsFrame;
      }
      await stageLog?.("info", "claim-navigation", "Optum Pro claims-ui iframe was replaced while settling; re-resolving.");
    }
    await rootPage.waitForTimeout(300);
  }
  throw new Error("Timed out waiting for the Optum Pro claims-ui iframe to appear.");
}

function createClaimsScope(rootPage: Page, frame: Frame): Page {
  const handler: ProxyHandler<Record<PropertyKey, unknown>> = {
    get(_target, prop) {
      if (prop === CLAIMS_SCOPE_ROOT_PAGE) return rootPage;
      if (prop === "keyboard" || prop === "mouse" || prop === "touchscreen") {
        return (rootPage as unknown as Record<PropertyKey, unknown>)[prop as string];
      }
      const value = (frame as unknown as Record<PropertyKey, unknown>)[prop as string];
      return typeof value === "function" ? value.bind(frame) : value;
    },
  };
  return new Proxy({}, handler) as unknown as Page;
}

function rootPageOf(page: Page): Page {
  const maybeRoot = (page as unknown as Record<PropertyKey, unknown>)[CLAIMS_SCOPE_ROOT_PAGE];
  return (maybeRoot as Page | undefined) ?? page;
}

async function dismissOptumBlockingPopups(page: Page, stageLog?: StageLog): Promise<boolean> {
  const popup = page.locator("text=/Your opinion matters!/i").first();
  if (!(await popup.isVisible({ timeout: 500 }).catch(() => false))) return false;

  const closeClicked = await page.evaluate(() => {
    const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const visible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const title = Array.from(document.querySelectorAll("body *"))
      .find((element) => visible(element) && clean((element as HTMLElement).innerText) === "Your opinion matters!");
    const root = title?.closest("[role='dialog'], mat-dialog-container, .cdk-overlay-pane")
      ?? title?.parentElement?.parentElement?.parentElement
      ?? document.body;
    const elements = Array.from(root.querySelectorAll("button, [role='button']"))
      .filter((element) => visible(element) && clean((element as HTMLElement).innerText) !== "Yes, after my visit");
    const closeButton = elements.find((element) => {
      const label = clean(element.getAttribute("aria-label")).toLowerCase();
      const text = clean((element as HTMLElement).innerText);
      return label.includes("close") || text === "";
    }) as HTMLElement | undefined;
    closeButton?.click();
    return Boolean(closeButton);
  }).catch(() => false);

  if (closeClicked) {
    await page.waitForTimeout(200);
    await stageLog?.("info", "claim-search", "Dismissed Optum feedback popup.");
    return true;
  }

  const noButton = page.locator("button:has-text('No'), [role='button']:has-text('No')").first();
  if (await noButton.isVisible({ timeout: 500 }).catch(() => false)) {
    await noButton.click({ timeout: 500 }).catch(() => {});
    await page.waitForTimeout(200);
    await stageLog?.("info", "claim-search", "Dismissed Optum feedback popup.");
    return true;
  }

  return false;
}

async function retryAfterBlockingPopup<T>(
  page: Page,
  stageLog: StageLog | undefined,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!isTimeoutError(error)) throw error;
    await dismissOptumBlockingPopups(page, stageLog);
    return action();
  }
}

async function clickWithBlockingPopupRetry(page: Page, stageLog: StageLog | undefined, action: () => Promise<void>): Promise<void> {
  await retryAfterBlockingPopup(page, stageLog, action);
}

async function fillInputLikeUser(page: Page, selector: string, value: string, stageLog?: StageLog): Promise<void> {
  await retryAfterBlockingPopup(page, stageLog, async () => {
    const locator = page.locator(selector).first();
    await locator.waitFor({ state: "visible", timeout: 30000 });
    await locator.click();
    await page.keyboard.press("Control+A");
    await page.keyboard.press("Backspace");
    await locator.pressSequentially(value, { delay: 60 });
    await page.waitForTimeout(300);
  });
}

async function waitForCondition(timeout: number, pollMs: number, condition: () => Promise<boolean>, checkCancellation?: CancellationCheck): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    checkCancellation?.();
    if (await condition().catch(() => false)) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return false;
}

async function visibleRows(page: Page): Promise<Array<{ index: number; text: string }>> {
  const rows = page.locator("tbody tr:visible");
  const count = await rows.count().catch(() => 0);
  const values: Array<{ index: number; text: string }> = [];
  for (let index = 0; index < count; index++) {
    const text = await rows.nth(index).innerText({ timeout: 1000 }).catch(() => "");
    if (text.trim()) values.push({ index, text: text.replace(/\s+/g, " ").trim() });
  }
  return values;
}

function similarityScore(candidate: string, wanted: string): number {
  const candidateName = normalizeName(candidate);
  const wantedName = normalizeName(wanted);
  if (!candidateName || !wantedName) return 0;
  if (candidateName === wantedName) return 1000;
  if (candidateName.includes(wantedName) || wantedName.includes(candidateName)) return 700;

  const candidateTokens = new Set(candidateName.split(" ").filter(Boolean));
  const wantedTokens = wantedName.split(" ").filter(Boolean);
  return wantedTokens.reduce((score, token) => score + (candidateTokens.has(token) ? 100 : 0), 0);
}

function bestPatientRow(rows: Array<{ index: number; text: string }>, patient: string): { index: number; text: string } | undefined {
  let best: { row: { index: number; text: string }; score: number } | undefined;
  for (const row of rows) {
    const score = similarityScore(row.text, patient);
    if (!best || score > best.score) best = { row, score };
  }
  return best && best.score > 0 ? best.row : undefined;
}

function patientNameMatches(candidate: string, wanted: string): boolean {
  const candidateName = normalizeName(candidate);
  const wantedName = normalizeName(wanted);
  return Boolean(candidateName && wantedName && (candidateName === wantedName || candidateName.includes(wantedName) || wantedName.includes(candidateName)));
}

function patientDropdownRowLocator(page: Page) {
  const dropdown = page
    .locator("div.absolute.left-0.right-0.top-full:visible")
    .filter({ has: page.getByText("Subscriber ID", { exact: true }) });
  return dropdown.locator("div.max-h-60.overflow-y-auto > div.grid.grid-cols-3");
}

async function patientDropdownRows(page: Page): Promise<PatientDropdownRow[]> {
  const rows = patientDropdownRowLocator(page);
  const count = await rows.count().catch(() => 0);
  const values: PatientDropdownRow[] = [];
  for (let index = 0; index < count; index++) {
    const row = rows.nth(index);
    const cells = await row.locator(":scope > div").allInnerTexts().catch(() => []);
    const text = (await row.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ").trim();
    const subscriberId = (cells[0] || "").replace(/\s+/g, " ").trim();
    const patientName = (cells[1] || "").replace(/\s+/g, " ").trim();
    if (text && !/subscriber id/i.test(text)) {
      values.push({ index, text, subscriberId, patientName });
    }
  }
  return values;
}

async function waitForPatientDropdownRows(page: Page, timeout = 5000): Promise<PatientDropdownRow[]> {
  let rows: PatientDropdownRow[] = [];
  await waitForCondition(timeout, 250, async () => {
    rows = await patientDropdownRows(page);
    return rows.length > 0;
  });
  return rows;
}

async function selectPatient(page: Page, row: OptumProInputRow, mode: PatientSelectionMode, stageLog?: StageLog): Promise<PatientSelection> {
  const attempts = [row.memberId];
  const strippedMemberId = leadingThreeLettersStripped(row.memberId);
  if (strippedMemberId !== row.memberId) attempts.push(strippedMemberId);

  for (const memberId of attempts) {
    await fillInputLikeUser(page, CLAIM_SEARCH_PATIENT_SELECTOR, memberId, stageLog);

    const parsedRows = await waitForPatientDropdownRows(page);
    const samePatientRows = parsedRows.filter((candidate) => patientNameMatches(candidate.patientName, row.patient));
    const exactSubscriberMatch = samePatientRows.find((candidate) => normalize(candidate.subscriberId) === normalize(memberId));
    const blankSubscriberMatch = samePatientRows.find((candidate) => !candidate.subscriberId);
    const duplicateSamePatientRows = samePatientRows.length >= 2;

    const visibleDropdownRows = parsedRows.map(({ index, text }) => ({ index, text }));
    const looseMatch = bestPatientRow(visibleDropdownRows, row.patient)
      ?? visibleDropdownRows.find((candidate) => normalize(candidate.text).includes(normalize(memberId)));

    const match = mode === "blank-subscriber"
      ? blankSubscriberMatch
      : duplicateSamePatientRows && exactSubscriberMatch
        ? exactSubscriberMatch
        : looseMatch
          ? { index: looseMatch.index, text: looseMatch.text, subscriberId: "", patientName: "" }
          : exactSubscriberMatch ?? blankSubscriberMatch;

    if (match) {
      await clickWithBlockingPopupRetry(page, stageLog, () => patientDropdownRowLocator(page).nth(match.index).click());
      await page.waitForTimeout(300);
      return {
        text: match.text,
        allowBlankSubscriberFallback: mode === "loose" && duplicateSamePatientRows && Boolean(exactSubscriberMatch && blankSubscriberMatch && match.index === exactSubscriberMatch.index),
      };
    }
  }

  throw new Error(`No patient dropdown match found for Member Id ${row.memberId} / patient ${row.patient}.`);
}

async function selectMedicalGroup(page: Page, medicalGroupName: string, stageLog?: StageLog): Promise<string> {
  const searchText = buildMedicalGroupSearch(medicalGroupName);
  if (!searchText) throw new Error(`Medical group not found for ${medicalGroupName}.`);

  const target = normalizeMedicalGroupForCompare(medicalGroupName);
  const targetWords = target.split(" ").filter(Boolean);

  for (let attempt = 1; attempt <= 2; attempt++) {
    await fillInputLikeUser(page, CLAIM_SEARCH_MEDICAL_GROUP_SELECTOR, searchText, stageLog);
    await waitForStableMedicalGroupOptions(page);

    const bestOption = await bestMedicalGroupOption(page, targetWords);
    if (bestOption.index >= 0 && bestOption.score >= 40) {
      await clickWithBlockingPopupRetry(page, stageLog, () => medicalGroupOptions(page).nth(bestOption.index).click());
      await page.waitForTimeout(300);
      return bestOption.text;
    }
  }

  for (const fallbackSearchText of medicalGroupFallbackSearches(medicalGroupName)) {
    await fillInputLikeUser(page, CLAIM_SEARCH_MEDICAL_GROUP_SELECTOR, fallbackSearchText, stageLog);
    await waitForStableMedicalGroupOptions(page);

    const bestOption = await bestMedicalGroupOption(page, targetWords);
    if (bestOption.index >= 0 && bestOption.score >= 40) {
      await clickWithBlockingPopupRetry(page, stageLog, () => medicalGroupOptions(page).nth(bestOption.index).click());
      await page.waitForTimeout(300);
      return bestOption.text;
    }
  }

  throw new Error(`Medical group not found for ${medicalGroupName}.`);
}

function medicalGroupFallbackSearches(medicalGroupName: string): string[] {
  const normalizedWords = normalizeMedicalGroupForCompare(medicalGroupName).split(" ").filter(Boolean);
  const searches = [
    normalizedWords.slice(0, 2).join(" "),
    normalizedWords.slice(0, 3).join(" "),
    normalizeMedicalGroupForCompare(medicalGroupName),
  ].filter(Boolean);
  return Array.from(new Set(searches));
}

function medicalGroupOptions(page: Page) {
  // Medical group is a cmdk combobox, structurally identical to the date-type
  // field (`selectDateTypeOption`): options are rendered as
  // `<div cmdk-item="" role="option" data-value="NAME EIN">NAME EIN</div>`
  // inside a portal-rendered `[role="dialog"]` > `[cmdk-list]`. The dropdown
  // closes on blur/outside interaction like any Radix Popover, so callers
  // must not do anything that moves focus away between filling the input and
  // reading/clicking these options.
  return page.locator("[role='option'][cmdk-item]:visible");
}

async function waitForStableMedicalGroupOptions(page: Page): Promise<void> {
  let previousCount = -1;
  let stableChecks = 0;
  for (let attempt = 0; attempt < 10; attempt++) {
    await page.waitForTimeout(400);
    const count = await medicalGroupOptions(page).count().catch(() => 0);
    if (count > 0 && count === previousCount) {
      stableChecks++;
      if (stableChecks >= 2) return;
    } else {
      stableChecks = 0;
      previousCount = count;
    }
  }
}

async function bestMedicalGroupOption(page: Page, targetWords: string[]): Promise<{ index: number; score: number; text: string }> {
  const options = medicalGroupOptions(page);
  const count = await options.count().catch(() => 0);
  let bestIndex = -1;
  let bestScore = 0;
  let bestText = "";

  for (let index = 0; index < count; index++) {
    const optionText = (await options.nth(index).innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ").trim();
    const score = medicalGroupOptionScore(optionText, targetWords);

    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
      bestText = optionText;
    }
  }

  return { index: bestIndex, score: bestScore, text: bestText };
}

function commonPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
}

function medicalGroupOptionScore(optionText: string, targetWords: string[]): number {
  const optionNorm = normalizeMedicalGroupForCompare(optionText);
  let score = 0;

  for (const word of targetWords) {
    if (optionNorm.includes(word)) score += 10;
  }

  const firstWord = targetWords[0];
  const lastWord = targetWords[targetWords.length - 1];
  if (firstWord && optionNorm.includes(firstWord)) {
    score += 20;
  }
  if (lastWord && optionNorm.includes(lastWord)) {
    score += 30;
  }

  const longestWord = targetWords.reduce((best, word) => word.length > best.length ? word : best, "");
  if (longestWord && optionNorm.includes(longestWord)) {
    score += 30;
  }

  return score;
}

/**
 * Optum's "Date type" field used to be a native <select>, which
 * `setServiceDate` handled via `selectOption({ label })`. It's now a
 * Radix/cmdk combobox: clicking `button#date-type` opens a portal-rendered
 * `[role="dialog"]` containing a `cmdk-list` of `[role="option"][cmdk-item]`
 * divs ("Service date" / "Processed date"). There's no native <select>
 * anywhere on the page anymore, so the old logic silently found nothing and
 * no-opped — this is the replacement.
 *
 * The field is disabled until Patient details or Medical group name has a
 * value, so this is a no-op (with a log line) if the button is still
 * disabled when called; callers are expected to have already filled one of
 * those fields first.
 */
async function selectDateTypeOption(page: Page, optionLabel: string, stageLog?: StageLog): Promise<void> {
  const dateTypeButton = page.locator("#date-type");
  if (!(await dateTypeButton.isVisible({ timeout: 5000 }).catch(() => false))) {
    await stageLog?.("warn", "claim-search", "Date type button not visible; skipping date type selection.");
    return;
  }

  const isDisabled = await dateTypeButton.getAttribute("disabled").then((value) => value !== null).catch(() => false);
  if (isDisabled) {
    await stageLog?.("warn", "claim-search", "Date type button is disabled (patient/medical group not yet filled); skipping date type selection.");
    return;
  }

  await retryAfterBlockingPopup(page, stageLog, async () => {
    await dateTypeButton.click();
  });

  const option = page.locator("[role='option'][cmdk-item]").filter({ hasText: optionLabel }).first();
  const optionAppeared = await option.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  if (!optionAppeared) {
    await stageLog?.("warn", "claim-search", `Date type option "${optionLabel}" did not appear; closing dropdown without selecting.`);
    await page.keyboard.press("Escape").catch(() => {});
    return;
  }

  await clickWithBlockingPopupRetry(page, stageLog, () => option.click());
  // cmdk closes its own popover on select; this is just a safety net in case it doesn't.
  await page.keyboard.press("Escape").catch(() => {});
}

async function setServiceDate(page: Page, dos: string, stageLog?: StageLog): Promise<void> {
  const normalizedDos = normalizeDate(dos);
  await selectDateTypeOption(page, "Service date", stageLog);

  const dateInputs = page.locator("input[placeholder*='MM/DD/YYYY']:visible");
  const dateInputCount = await dateInputs.count().catch(() => 0);
  if (dateInputCount >= 2) {
    for (let index = 0; index < 2; index++) {
      const input = dateInputs.nth(index);
      await retryAfterBlockingPopup(page, stageLog, async () => {
        await input.waitFor({ state: "visible", timeout: 30000 });
        await input.fill("");
        await input.fill(normalizedDos);
        const enteredDate = await input.inputValue();
        if (normalizeDate(enteredDate) !== normalizedDos) {
          await input.selectText();
          await input.pressSequentially(normalizedDos, { delay: 45 });
        }
        await input.press("Tab");
      });
    }
  } else {
    const dateRangeInput = dateInputs.first();
    await retryAfterBlockingPopup(page, stageLog, async () => {
      await dateRangeInput.waitFor({ state: "visible", timeout: 30000 });
      const dateRange = `${normalizedDos} - ${normalizedDos}`;
      await dateRangeInput.fill("");
      await dateRangeInput.fill(dateRange);
      if (!(await dateRangeInput.inputValue()).includes(normalizedDos)) {
        await dateRangeInput.selectText();
        await dateRangeInput.pressSequentially(dateRange, { delay: 45 });
      }
      await dateRangeInput.press("Tab");
    });
  }
  await page.waitForTimeout(250);
}

async function captureResultSummary(page: Page): Promise<string> {
  await waitForCondition(10000, 250, async () => {
    if (await page.locator("text=/Results? Found|No Claims found/i").first().isVisible({ timeout: 100 }).catch(() => false)) {
      return true;
    }
    return (await claimResultRows(page).then((rows) => rows.count()).catch(() => 0)) > 0;
  });
  const summaryText = await page.locator("text=/Results? Found/i").first().innerText({ timeout: 1000 }).catch(() => "");
  const rows = await visibleRows(page);
  if (!rows.length) return summaryText || "No result rows visible.";
  return [summaryText, rows.map((row) => row.text).join(" | ")].filter(Boolean).join(" - ");
}

function emptyClaimResult(input: OptumProInputRow, fields: Partial<OptumProSearchResult> = {}): OptumProSearchResult {
  return {
    input,
    rowNumber: input.rowNumber,
    medicalGroupName: input.medicalGroupName,
    patient: input.patient,
    dos: input.dos,
    cpt: input.cpt,
    memberId: input.memberId,
    matchedPatient: "",
    matchedGroup: "",
    claimNumber: "",
    claimReceivedDate: "",
    processedDate: "",
    serviceCode: "",
    billedAmount: "",
    planAllowedAmount: "",
    patientResponsibility: "",
    withholdAmount: "",
    deniedAmount: "",
    paidAmount: "",
    lineStatus: "",
    explanationCode: "",
    explanationDescription: "",
    copayAmount: "",
    coinsuranceAmount: "",
    deductibleAmount: "",
    paymentMode: "",
    paymentType: "",
    eftNumber: "",
    eftAmount: "",
    paymentDate: "",
    paymentId: "",
    paymentName: "",
    payeeName: "",
    resultSummary: "",
    status: "",
    notes: "",
    ...fields,
  };
}

async function claimResultRows(page: Page) {
  const currentRows = page.locator("tbody[data-cy='table-body'] tr[data-cy^='table-row-']:visible");
  if ((await currentRows.count().catch(() => 0)) > 0) return currentRows;
  const primary = page.locator("tr[data-name='Claims-View-Details']:visible");
  if ((await primary.count().catch(() => 0)) > 0) return primary;
  const dataNameRows = page.locator("tbody tr:visible").filter({ has: page.locator("[data-name='Claims-View-Details']") });
  if ((await dataNameRows.count().catch(() => 0)) > 0) return dataNameRows;
  return page.locator("table:visible tbody tr:visible").filter({ has: page.locator("td") });
}

function resultRowScore(text: string, row: OptumProInputRow): number {
  const normalized = normalize(text);
  let score = 0;
  if (normalized.includes(normalize(row.memberId))) score += 500;
  if (normalized.includes(normalize(row.patient))) score += 300;
  if (normalized.includes(normalizeDate(row.dos).replace(/\//g, ""))) score += 200;
  return score;
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function resultTableHeaderIndexes(page: Page): Promise<{ claimNumberIndex: number; statusIndex: number }> {
  const headers = (await page.locator("table:visible thead th:visible").allInnerTexts().catch(() => []))
    .map((header) => normalizeHeader(header));
  return {
    claimNumberIndex: headers.findIndex((header) => header === "claimnumber"),
    statusIndex: headers.findIndex((header) => header === "status"),
  };
}

async function claimResultCandidate(page: Page, index: number, row: OptumProInputRow): Promise<ClaimResultCandidate> {
  const rows = await claimResultRows(page);
  const resultRow = rows.nth(index);
  const text = (await resultRow.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ").trim();
  const cells = (await resultRow.locator("td").allInnerTexts().catch(() => []))
    .map((cell) => cell.replace(/\s+/g, " ").trim());
  const nonEmptyCells = cells.filter(Boolean);
  const headerIndexes = await resultTableHeaderIndexes(page);
  const claimNumberFromHeader = headerIndexes.claimNumberIndex >= 0 ? cells[headerIndexes.claimNumberIndex] || "" : "";
  const statusFromHeader = headerIndexes.statusIndex >= 0 ? cells[headerIndexes.statusIndex] || "" : "";
  const claimNumber = await resultRow.locator("[class*='claimNumber'], [class*='claim-number']").first().innerText({ timeout: 500 })
    .then((value) => value.replace(/\s+/g, " ").trim())
    .catch(() => claimNumberFromHeader || nonEmptyCells.find((cell) => /^\d{5,}$/.test(cell)) || "");
  const resultStatus = await resultRow.locator("[class*='status']").last().innerText({ timeout: 500 }).then((value) => value.replace(/\s+/g, " ").trim()).catch(() => {
    if (statusFromHeader) return statusFromHeader;
    const knownStatus = nonEmptyCells.find((cell) => /^(in\s*(process|progress)|processed|paid|denied|pending)$/i.test(cell));
    if (knownStatus) return knownStatus;
    const parts = text.split(/\s+/).filter(Boolean);
    return parts[parts.length - 1] || "";
  });
  const claimNumberFromText = text.match(/\b\d{5,}\b/)?.[0] || "";
  return {
    index,
    score: resultRowScore(text, row),
    text,
    claimNumber: claimNumber || claimNumberFromText,
    resultStatus,
  };
}

async function orderedClaimResultIndexes(page: Page, row: OptumProInputRow): Promise<ClaimResultCandidate[]> {
  const rows = await claimResultRows(page);
  const count = await rows.count().catch(() => 0);
  const indexedRows: ClaimResultCandidate[] = [];
  for (let index = 0; index < count; index++) {
    indexedRows.push(await claimResultCandidate(page, index, row));
  }
  return indexedRows.sort((left, right) => right.score - left.score);
}

function isInProgressStatus(status: string): boolean {
  return /in\s*(process|progress)/i.test(status);
}

async function hasClaimDetailsPageSignals(page: Page, timeout = 300): Promise<boolean> {
  for (const selector of CLAIM_DETAILS_PAGE_SIGNALS) {
    if (await page.locator(selector).first().isVisible({ timeout }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function hasClaimSearchResultTable(page: Page, timeout = 100): Promise<boolean> {
  const dataNameRows = page.locator("tr[data-name='Claims-View-Details']:visible, tbody tr:visible [data-name='Claims-View-Details']");
  return (await dataNameRows.first().isVisible({ timeout }).catch(() => false))
    || (await page.locator("text=/Summary|Results? Found/i").first().isVisible({ timeout }).catch(() => false));
}

async function claimDetailsOpenState(page: Page, timeout = 100): Promise<{
  urlAfterClick: string;
  detailUrlMatched: boolean;
  detailSelectorMatched: boolean;
  claimSearchResultsActive: boolean;
  detailsOpened: boolean;
}> {
  const urlAfterClick = page.url();
  const detailUrlMatched = urlAfterClick.includes("/claim-details");
  const detailSelectorMatched = await hasClaimDetailsPageSignals(page, timeout);
  const claimSearchResultsActive = await hasClaimSearchResultTable(page, timeout);
  return {
    urlAfterClick,
    detailUrlMatched,
    detailSelectorMatched,
    claimSearchResultsActive,
    detailsOpened: detailUrlMatched || (detailSelectorMatched && !claimSearchResultsActive),
  };
}

async function hasConfirmedClaimDetailsPage(page: Page, timeout = 300): Promise<boolean> {
  return (await claimDetailsOpenState(page, timeout)).detailsOpened;
}

async function closeTransientClaimDetailsSnackbar(page: Page): Promise<void> {
  const snackbar = page.locator(
    ".ecp-ucl-snackbar:has-text('Something unexpected happened'), [role='alert']:has-text('Something unexpected happened')",
  ).first();
  if (!(await snackbar.isVisible({ timeout: 100 }).catch(() => false))) return;
  await snackbar.locator(
    "button[aria-label*='close' i], [role='button'][aria-label*='close' i], button:has-text('Close')",
  ).last().click({ timeout: 500 }).catch(() => {});
}

async function closeClaimDetailsUnavailablePopup(page: Page): Promise<string> {
  if (await hasConfirmedClaimDetailsPage(page, 100)) {
    await closeTransientClaimDetailsSnackbar(page);
    return "";
  }

  const popup = page.locator("text=/Claim details unavailable|claim details.*wasn.t found|claim details.*not.*found|details.*not.*available/i").first();
  if (!(await popup.isVisible({ timeout: 1500 }).catch(() => false))) return "";
  const message = (await popup.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ").trim();
  const closeButton = page.locator(
    "button:has-text('Close'), [role='button']:has-text('Close'), button[aria-label*='close' i], [role='button'][aria-label*='close' i]",
  ).last();
  await closeButton.click({ timeout: 1000 }).catch(() => page.keyboard.press("Escape"));
  await page.waitForTimeout(200);
  return message || "Claim details unavailable popup was shown.";
}

async function claimDetailsUnavailablePopupMessage(page: Page, timeout = 100): Promise<string> {
  const popup = page.locator("text=/Claim details unavailable|claim details.*wasn.t found|claim details.*not.*found|details.*not.*available/i").first();
  if (!(await popup.isVisible({ timeout }).catch(() => false))) return "";
  return (await popup.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ").trim()
    || "Claim details unavailable popup was shown.";
}

async function waitForClaimDetailsUnavailablePopup(page: Page, timeout = 8000, checkCancellation?: CancellationCheck): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    checkCancellation?.();
    if (await hasConfirmedClaimDetailsPage(page, 100)) {
      await closeTransientClaimDetailsSnackbar(page);
      return "";
    }

    const message = await closeClaimDetailsUnavailablePopup(page);
    if (message) return message;
    await page.waitForTimeout(250);
  }
  return "";
}

async function waitForClaimDetailsPage(page: Page, timeout = 45000, checkCancellation?: CancellationCheck): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    checkCancellation?.();
    if (await hasConfirmedClaimDetailsPage(page)) {
      await closeTransientClaimDetailsSnackbar(page);
      return;
    }

    const unavailableMessage = await closeClaimDetailsUnavailablePopup(page);
    if (unavailableMessage) {
      throw new Error(`Claim details unavailable: ${unavailableMessage}`);
    }

    await page.waitForTimeout(300);
  }
  throw new Error("Timed out waiting for Optum Pro claim details page.");
}

async function openClaimResultRowByIndex(
  page: Page,
  index: number,
  stageLog: StageLog,
  checkCancellation?: CancellationCheck,
): Promise<{ text: string; detailsOpened: boolean; detailsUnavailable: boolean; unavailableMessage: string }> {
  const rows = await claimResultRows(page);
  const row = rows.nth(index);
  const text = (await row.innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ").trim();
  const claimNumberCell = row.locator("td").nth(1);
  const legacyOpenTarget = row.locator("a, [data-name='Claims-View-Details']").first();
  await stageLog("info", "claim-search", `Clicked claim result row ${index + 1}: ${text || "(no row text)"}.`);
  if (await claimNumberCell.isVisible({ timeout: 1000 }).catch(() => false)) {
    await claimNumberCell.click();
  } else if (await legacyOpenTarget.isVisible({ timeout: 1000 }).catch(() => false)) {
    await legacyOpenTarget.click();
  } else {
    await row.click();
  }

  const startedAt = Date.now();
  let unavailableMessage = "";
  while (Date.now() - startedAt < 8000) {
    checkCancellation?.();
    const detailState = await claimDetailsOpenState(page, 100);
    if (detailState.detailsOpened) {
      await closeTransientClaimDetailsSnackbar(page);
      await page.waitForTimeout(400);
      await stageLog("info", "claim-search", `Claim result row ${index + 1}: urlAfterClick=${detailState.urlAfterClick}; detailUrlMatched=${detailState.detailUrlMatched}; detailSelectorMatched=${detailState.detailSelectorMatched}; final detailsOpened decision=true.`);
      await stageLog("info", "claim-search", `Claim result row ${index + 1}: details page opened true; unavailable popup seen ${Boolean(unavailableMessage)}.`);
      return { text, detailsOpened: true, detailsUnavailable: false, unavailableMessage };
    }

    unavailableMessage ||= await claimDetailsUnavailablePopupMessage(page, 100);
    if (unavailableMessage && (page.url().includes("/claims-panel") || Date.now() - startedAt >= 3000)) {
      const closeButton = page.locator(
        "button:has-text('Close'), [role='button']:has-text('Close'), button[aria-label*='close' i], [role='button'][aria-label*='close' i]",
      ).last();
      await closeButton.click({ timeout: 1000 }).catch(() => page.keyboard.press("Escape"));
      await page.waitForTimeout(200);
      await stageLog("info", "claim-search", `Claim result row ${index + 1}: urlAfterClick=${detailState.urlAfterClick}; detailUrlMatched=${detailState.detailUrlMatched}; detailSelectorMatched=${detailState.detailSelectorMatched}; final detailsOpened decision=false.`);
      await stageLog("info", "claim-search", `Claim result row ${index + 1}: details page opened false; unavailable popup seen true.`);
      return { text, detailsOpened: false, detailsUnavailable: true, unavailableMessage };
    }

    await page.waitForTimeout(250);
  }

  if (unavailableMessage) {
    const detailState = await claimDetailsOpenState(page, 100);
    await stageLog("info", "claim-search", `Claim result row ${index + 1}: urlAfterClick=${detailState.urlAfterClick}; detailUrlMatched=${detailState.detailUrlMatched}; detailSelectorMatched=${detailState.detailSelectorMatched}; final detailsOpened decision=false.`);
    await stageLog("info", "claim-search", `Claim result row ${index + 1}: details page opened false; unavailable popup seen true.`);
    return { text, detailsOpened: false, detailsUnavailable: true, unavailableMessage };
  }

  const detailState = await claimDetailsOpenState(page, 100);
  await stageLog("info", "claim-search", `Claim result row ${index + 1}: urlAfterClick=${detailState.urlAfterClick}; detailUrlMatched=${detailState.detailUrlMatched}; detailSelectorMatched=${detailState.detailSelectorMatched}; final detailsOpened decision=false.`);
  await stageLog("info", "claim-search", `Claim result row ${index + 1}: details page opened false; unavailable popup seen false.`);
  throw new Error("Timed out waiting for Optum Pro claim details page.");
}

async function returnToClaimResults(page: Page): Promise<void> {
  const backButton = page.locator("button:has-text('Back')").first();
  if (await backButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    await backButton.click();
  } else {
    const claimsBreadcrumb = page.getByText("Claims", { exact: true }).first();
    if (await claimsBreadcrumb.isVisible({ timeout: 3000 }).catch(() => false)) {
      await claimsBreadcrumb.click();
    }
  }
  await page.locator("text=/Summary|Results? Found/i").first().waitFor({ state: "visible", timeout: 45000 }).catch(() => {});
  await claimResultRows(page).then((rows) => rows.first().waitFor({ state: "visible", timeout: 45000 })).catch(() => {});
}

async function findMatchingClaimDetails(
  page: Page,
  row: OptumProInputRow,
  stageLog: StageLog,
  checkCancellation?: CancellationCheck,
): Promise<{ clickedRowText: string; details: Partial<OptumProSearchResult>; status: string; notes?: string } | null> {
  const candidates = await orderedClaimResultIndexes(page, row);
  let unavailableResult: { clickedRowText: string; details: Partial<OptumProSearchResult>; notes: string } | null = null;
  let openedDetailsCount = 0;
  for (const candidate of candidates) {
    checkCancellation?.();
    if (isInProgressStatus(candidate.resultStatus)) {
      await stageLog("info", "claim-search", `Final claim result status reason: result row ${candidate.index + 1} is in progress; details were not opened.`);
      return {
        clickedRowText: candidate.text,
        status: candidate.resultStatus || "In Progress",
        details: {
          claimNumber: candidate.claimNumber,
          lineStatus: candidate.resultStatus || "In Progress",
        },
        notes: "Claim result is in progress; details were not opened.",
      };
    }

    const opened = await openClaimResultRowByIndex(page, candidate.index, stageLog, checkCancellation);
    if (opened.detailsUnavailable) {
      unavailableResult ??= {
        clickedRowText: opened.text,
        details: {
          claimNumber: candidate.claimNumber,
          lineStatus: candidate.resultStatus,
        },
        notes: opened.unavailableMessage || "Claim details unavailable popup was shown.",
      };
      await stageLog("info", "claim-search", `Skipping claim result row ${candidate.index + 1}: ${opened.unavailableMessage || "claim details unavailable popup was shown"}.`);
      continue;
    }
    if (!opened.detailsOpened) {
      await stageLog("info", "claim-search", `Skipping claim result row ${candidate.index + 1}: Claim Details page was not confirmed opened.`);
      continue;
    }

    openedDetailsCount++;
    checkCancellation?.();
    const details = await extractClaimDetails(page, row);
    const serviceCode = typeof details.serviceCode === "string" ? details.serviceCode : "";
    if (normalize(serviceCode) === normalize(row.cpt)) {
      await stageLog("info", "claim-search", `Final claim result status reason: claim details opened and service code ${serviceCode || "-"} matched CPT ${row.cpt}.`);
      return { clickedRowText: opened.text, details, status: "Completed" };
    }

    await stageLog("info", "claim-search", `Skipping claim result row ${candidate.index + 1}: service code ${serviceCode || "-"} did not match CPT ${row.cpt}.`);
    await returnToClaimResults(page);
  }

  if (!openedDetailsCount && unavailableResult) {
    await stageLog("info", "claim-search", "Final claim result status reason: result rows existed, but no Claim Details page opened and unavailable popup was shown.");
    return {
      ...unavailableResult,
      status: "Claim details unavailable",
    };
  }

  if (openedDetailsCount) {
    await stageLog("info", "claim-search", `Final claim result status reason: ${openedDetailsCount} Claim Details page(s) opened, but none contained CPT/service code ${row.cpt}.`);
  } else {
    await stageLog("info", "claim-search", "Final claim result status reason: result rows existed, but no Claim Details page opened.");
  }

  return null;
}

async function textAfterLabel(page: Page, label: string): Promise<string> {
  return page.evaluate((targetLabel) => {
    const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const wanted = clean(targetLabel).toLowerCase();
    const visible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const elements = Array.from(document.querySelectorAll("body *"))
      .filter((element) => visible(element) && clean((element as HTMLElement).innerText).toLowerCase() === wanted);

    for (const element of elements) {
      const parent = element.parentElement;
      if (parent) {
        const children = Array.from(parent.children);
        const index = children.indexOf(element);
        for (const sibling of children.slice(index + 1)) {
          const text = clean((sibling as HTMLElement).innerText);
          if (text && text.toLowerCase() !== wanted) return text;
        }
      }

      let cursor: Element | null = element.nextElementSibling;
      while (cursor) {
        const text = clean((cursor as HTMLElement).innerText);
        if (text && text.toLowerCase() !== wanted) return text;
        cursor = cursor.nextElementSibling;
      }
    }

    return "";
  }, label).catch(() => "");
}

function fallbackDash(value: string): string {
  return value.trim() || "-";
}

function outputValue(value: string): string {
  return value.trim() || "-";
}

function outputMemberId(value: string): string {
  return value.trim() || "No Member Id Found";
}

function isStopRequestedError(error: unknown): boolean {
  return error instanceof OptumProStopRequestedError;
}

function optumProOutputPath(jobId: string): string {
  return path.join(getJobDataPath(jobId, "outputs"), "optum_pro_output_partial.xlsx");
}

async function writeAtomicFile(filePath: string, content: Buffer): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, content);
  await fs.rename(tempPath, filePath);
}

function emptyResultForRow(row: OptumProInputRow, status: string, notes: string): OptumProSearchResult {
  return {
    input: row,
    rowNumber: row.rowNumber,
    medicalGroupName: row.medicalGroupName,
    patient: row.patient,
    dos: row.dos,
    cpt: row.cpt,
    memberId: outputMemberId(row.memberId),
    matchedPatient: "",
    matchedGroup: "",
    claimNumber: "",
    claimReceivedDate: "",
    processedDate: "",
    serviceCode: "",
    billedAmount: "",
    planAllowedAmount: "",
    patientResponsibility: "",
    withholdAmount: "",
    deniedAmount: "",
    paidAmount: "",
    lineStatus: "",
    explanationCode: "",
    explanationDescription: "",
    copayAmount: "",
    coinsuranceAmount: "",
    deductibleAmount: "",
    paymentMode: "",
    paymentType: "",
    eftNumber: "",
    eftAmount: "",
    paymentDate: "",
    paymentId: "",
    paymentName: "",
    payeeName: "",
    resultSummary: "",
    status,
    notes,
  };
}

function rowFailed(result: OptumProSearchResult): boolean {
  return /^(error|stopped during processing|not processed - job stopped)$/i.test(result.status);
}

function buildOptumProJobMetadata(
  totalRows: number,
  results: Array<OptumProSearchResult | null>,
  stopped: boolean,
  partialOutputAvailable: boolean,
): OptumProPartialJobMetadata {
  const completedResults = results.filter((result): result is OptumProSearchResult => Boolean(result));
  const failedRows = completedResults.filter(rowFailed).length;
  return {
    totalRows,
    processedRows: completedResults.length,
    successfulRows: completedResults.length - failedRows,
    failedRows,
    stopped,
    partialOutputAvailable,
  };
}

function completeResultsForWorkbook(
  rows: OptumProInputRow[],
  results: Array<OptumProSearchResult | null>,
  stopped: boolean,
): OptumProSearchResult[] {
  return rows.map((row, index) => results[index] ?? emptyResultForRow(
    row,
    stopped ? "Not processed - job stopped" : "Not processed",
    stopped ? "Not processed - job stopped" : "Not processed.",
  ));
}

async function saveOptumProPartialWorkbook(
  context: ScraperContext,
  rows: OptumProInputRow[],
  results: Array<OptumProSearchResult | null>,
  stopped: boolean,
): Promise<{ path: string; buffer: Buffer; metadata: OptumProPartialJobMetadata }> {
  const workbookRows = completeResultsForWorkbook(rows, results, stopped);
  const buffer = createOptumProOutputWorkbookBuffer(workbookRows);
  const outputPath = optumProOutputPath(context.jobId);
  await writeAtomicFile(outputPath, buffer);
  return {
    path: outputPath,
    buffer,
    metadata: buildOptumProJobMetadata(rows.length, results, stopped, true),
  };
}

async function expandClaimDetailSections(page: Page): Promise<void> {
  const sectionNames = ["Payment information", "Billing information", "Claim information", "Line level details"];
  for (const sectionName of sectionNames) {
    const trigger = page.locator("button.accordion-trigger").filter({ hasText: sectionName }).first();
    if (!(await trigger.isVisible({ timeout: 5000 }).catch(() => false))) continue;
    if ((await trigger.getAttribute("aria-expanded").catch(() => null)) !== "true") {
      await trigger.click();
      await waitForCondition(5000, 100, async () => (await trigger.getAttribute("aria-expanded").catch(() => null)) === "true");
    }
  }
}

async function extractClaimDetails(page: Page, row: OptumProInputRow): Promise<Partial<OptumProSearchResult>> {
  await acknowledgeFinancialInfoBanner(page);
  await expandClaimDetailSections(page);
  const lineDetails = await extractMatchedLineDetails(page, row.cpt);
  const payeeId = await textAfterLabel(page, "Payee ID");
  const payeeName = await textAfterLabel(page, "Payee name");
  return {
    claimNumber: await textAfterLabel(page, "Claim number"),
    claimReceivedDate: await textAfterLabel(page, "Claim received date"),
    processedDate: await textAfterLabel(page, "Processed date"),
    ...lineDetails,
    paymentMode: await textAfterLabel(page, "Payment mode"),
    paymentType: await textAfterLabel(page, "Payment type"),
    eftNumber: fallbackDash(await textAfterLabel(page, "EFT number")),
    eftAmount: await textAfterLabel(page, "EFT amount"),
    paymentDate: await textAfterLabel(page, "Payment date"),
    paymentId: await textAfterLabel(page, "Payment ID") || payeeId,
    paymentName: await textAfterLabel(page, "Payment name") || payeeName,
    payeeName,
  };
}

async function acknowledgeFinancialInfoBanner(page: Page): Promise<void> {
  await page.locator("text=/Some financial information is not available/i").first().isVisible({ timeout: 500 }).catch(() => false);
}

async function extractMatchedLineDetails(page: Page, cpt: string): Promise<Partial<OptumProSearchResult>> {
  return page.evaluate((targetCpt) => {
    const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
    const normalizeCode = (value: string) => value.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
    const normalizeHeader = (value: string) => value.replace(/[^A-Za-z0-9]+/g, "").toLowerCase();
    const isVisible = (element: Element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    };
    const cellText = (row: Element, classPart: string) => {
      const cell = row.querySelector(`[class*="${classPart}"]`);
      return clean((cell as HTMLElement | null)?.innerText);
    };

    const rows = Array.from(document.querySelectorAll("tr"))
      .filter((candidate) => isVisible(candidate) && !candidate.className.includes("detail"));

    const matchedRow = rows.find((candidate) => normalizeCode(cellText(candidate, "procedureCode")) === normalizeCode(targetCpt));
    if (!matchedRow) {
      const empty = {
        serviceCode: "",
        billedAmount: "",
        planAllowedAmount: "",
        patientResponsibility: "",
        withholdAmount: "",
        deniedAmount: "",
        paidAmount: "",
        lineStatus: "",
        explanationCode: "",
        explanationDescription: "",
        copayAmount: "",
        coinsuranceAmount: "",
        deductibleAmount: "",
      };
      const headerIncludes = (header: string, words: string[]) => words.some((word) => header.includes(word));
      const tables = Array.from(document.querySelectorAll("table")).filter(isVisible);

      for (const table of tables) {
        const headers = Array.from(table.querySelectorAll("thead th"))
          .map((header) => normalizeHeader(clean((header as HTMLElement).innerText)));
        if (!headers.length) continue;

        const serviceIndex = headers.findIndex((header) => header.includes("servicecode") || header.includes("procedurecode"));
        if (serviceIndex < 0) continue;

        const amountIndex = headers.findIndex((header) => header.includes("billedamount") && header.includes("paidamount"));
        const indexes = {
          billed: headers.findIndex((header) => headerIncludes(header, ["billedamount", "billedamt"])),
          allowed: headers.findIndex((header) => header.includes("planallowed") || header.includes("allowedamount")),
          patient: headers.findIndex((header) => header.includes("patientresponsibility")),
          withhold: headers.findIndex((header) => header.includes("withhold")),
          denied: headers.findIndex((header) => header.includes("denied")),
          paid: headers.findIndex((header) => headerIncludes(header, ["paidamount", "amountpaid"])),
          status: headers.findIndex((header) => header === "status"),
        };

        const tableRows = Array.from(table.querySelectorAll("tbody tr"))
          .filter((candidate) => isVisible(candidate) && !candidate.className.includes("detail"));
        const fallbackRow = tableRows.find((candidate) => {
          const cells = Array.from(candidate.querySelectorAll("td"));
          return normalizeCode(clean((cells[serviceIndex] as HTMLElement | undefined)?.innerText)) === normalizeCode(targetCpt);
        });
        if (!fallbackRow) continue;

        const cells = Array.from(fallbackRow.querySelectorAll("td")).map((cell) => clean((cell as HTMLElement).innerText));
        const combinedAmounts = amountIndex >= 0 ? (cells[amountIndex] || "").split(",").map(clean) : [];
        const fallbackDetailRow = fallbackRow.nextElementSibling?.className.includes("detail")
          ? fallbackRow.nextElementSibling
          : null;
        const patientResponsibilityValues = fallbackDetailRow
          ? Array.from(fallbackDetailRow.querySelectorAll(".claims-card-content-address-text"))
            .map((element) => clean((element as HTMLElement).innerText))
            .filter(Boolean)
          : [];
        const explanationCodes = fallbackDetailRow
          ? Array.from(fallbackDetailRow.querySelectorAll(".denial-code"))
            .map((element) => clean((element as HTMLElement).innerText))
            .filter(Boolean)
          : [];
        const explanationDescriptions = fallbackDetailRow
          ? Array.from(fallbackDetailRow.querySelectorAll(".denial-code-desc"))
            .map((element) => clean((element as HTMLElement).innerText))
            .filter(Boolean)
          : [];

        return {
          serviceCode: cells[serviceIndex] || "",
          billedAmount: indexes.billed >= 0 ? cells[indexes.billed] || "" : combinedAmounts[0] || "",
          planAllowedAmount: indexes.allowed >= 0 ? cells[indexes.allowed] || "" : combinedAmounts[1] || "",
          patientResponsibility: indexes.patient >= 0 ? cells[indexes.patient] || "" : "",
          withholdAmount: indexes.withhold >= 0 ? cells[indexes.withhold] || "" : combinedAmounts[3] || "",
          deniedAmount: indexes.denied >= 0 ? cells[indexes.denied] || "" : combinedAmounts[4] || "",
          paidAmount: indexes.paid >= 0 ? cells[indexes.paid] || "" : combinedAmounts[5] || "",
          lineStatus: indexes.status >= 0 ? cells[indexes.status] || "" : "",
          explanationCode: explanationCodes.join(" | "),
          explanationDescription: explanationDescriptions.join(" | "),
          copayAmount: patientResponsibilityValues[0] || "",
          coinsuranceAmount: patientResponsibilityValues[1] || "",
          deductibleAmount: patientResponsibilityValues[2] || "",
        };
      }

      return empty;
    }

    const detailRow = matchedRow.nextElementSibling?.className.includes("detail")
      ? matchedRow.nextElementSibling
      : null;
    const patientResponsibilityValues = detailRow
      ? Array.from(detailRow.querySelectorAll(".claims-card-content-address-text"))
        .map((element) => clean((element as HTMLElement).innerText))
        .filter(Boolean)
      : [];
    const explanationCodes = detailRow
      ? Array.from(detailRow.querySelectorAll(".denial-code"))
        .map((element) => clean((element as HTMLElement).innerText))
        .filter(Boolean)
      : [];
    const explanationDescriptions = detailRow
      ? Array.from(detailRow.querySelectorAll(".denial-code-desc"))
        .map((element) => clean((element as HTMLElement).innerText))
        .filter(Boolean)
      : [];

    return {
      serviceCode: cellText(matchedRow, "procedureCode"),
      billedAmount: cellText(matchedRow, "billedAmt"),
      planAllowedAmount: cellText(matchedRow, "plannedAllowedAmt"),
      patientResponsibility: cellText(matchedRow, "patientResponsibilityAmt"),
      withholdAmount: cellText(matchedRow, "withHoldAmt"),
      deniedAmount: cellText(matchedRow, "deniedAmt"),
      paidAmount: cellText(matchedRow, "amountPaid"),
      lineStatus: cellText(matchedRow, "status"),
      explanationCode: explanationCodes.join(" | "),
      explanationDescription: explanationDescriptions.join(" | "),
      copayAmount: patientResponsibilityValues[0] || "",
      coinsuranceAmount: patientResponsibilityValues[1] || "",
      deductibleAmount: patientResponsibilityValues[2] || "",
    };
  }, cpt).catch(() => ({}));
}

async function returnToClaimSearch(page: Page, stageLog: StageLog): Promise<Page> {
  const currentUrl = page.url();
  if (currentUrl.includes("/claims-panel")) {
    return page;
  }

  if (currentUrl.includes("/dashboard")) {
    return openClaimsSearch(page, stageLog);
  }

  if (await hasClaimDetailsPageSignals(page, 300)) {
    const backButton = page.locator("button:has-text('Back')").first();
    if (await backButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      await backButton.click();
      if (await fastClaimSearchReady(page, CLAIM_SEARCH_READY_TIMEOUT_MS)) {
        return page;
      }
    }
  }

  return openClaimsSearch(page, stageLog);
}

async function fastClaimSearchReady(page: Page, timeout = FAST_CLAIM_SEARCH_READY_TIMEOUT_MS, checkCancellation?: CancellationCheck): Promise<boolean> {
  return waitForCondition(timeout, 150, async () => {
    if (!page.url().includes("/claims-panel")) return false;
    const claimSearchVisible = await page.locator("text=Claim Search").first().isVisible({ timeout: 100 }).catch(() => false);
    if (!claimSearchVisible) return false;
    const patientVisible = await page.locator(CLAIM_SEARCH_PATIENT_SELECTOR).first().isVisible({ timeout: 100 }).catch(() => false);
    const medicalGroupVisible = await page.locator(CLAIM_SEARCH_MEDICAL_GROUP_SELECTOR).first().isVisible({ timeout: 100 }).catch(() => false);
    const dateVisible = await page.locator(CLAIM_SEARCH_DATE_SELECTOR).first().isVisible({ timeout: 100 }).catch(() => false);
    const actionVisible = await page.locator(CLAIM_SEARCH_ACTION_SELECTOR).first().isVisible({ timeout: 100 }).catch(() => false);
    return patientVisible && medicalGroupVisible && dateVisible && actionVisible;
  }, checkCancellation);
}

async function waitForClaimSearchFormControls(page: Page, timeout = CLAIM_SEARCH_READY_TIMEOUT_MS): Promise<void> {
  await page.locator("text=Claim Search").first().waitFor({ state: "visible", timeout });
  await page.locator(CLAIM_SEARCH_PATIENT_SELECTOR).first().waitFor({ state: "visible", timeout });
  await page.locator(CLAIM_SEARCH_MEDICAL_GROUP_SELECTOR).first().waitFor({ state: "visible", timeout });
  await page.locator(CLAIM_SEARCH_DATE_SELECTOR).first().waitFor({ state: "visible", timeout });
  await page.locator(CLAIM_SEARCH_ACTION_SELECTOR).first().waitFor({ state: "visible", timeout });
}

async function dismissClaimSearchOverlays(page: Page): Promise<void> {
  await closeClaimDetailsUnavailablePopup(page).catch(() => "");
  await page.keyboard.press("Escape").catch(() => {});
}

async function clearClaimSearchFormIfVisible(page: Page): Promise<boolean> {
  const clearButton = page.locator("button:has-text('Clear search')").first();
  if (!(await clearButton.isVisible({ timeout: 500 }).catch(() => false))) return false;
  const clicked = await clearButton.click({ timeout: CLEAR_FORM_CLICK_TIMEOUT_MS })
    .then(() => true)
    .catch(async () => {
      await page.keyboard.press("Escape").catch(() => {});
      return false;
    });
  if (!clicked) return false;
  await fastClaimSearchReady(page, CLEAR_FORM_READY_TIMEOUT_MS);
  return true;
}

async function resetClaimSearchPage(
  page: Page,
  stageLog: StageLog,
  reason: string,
  timingLog?: RowTimingLog,
  timingLabelPrefix = "",
): Promise<Page> {
  const ensureStartedAt = Date.now();
  await dismissClaimSearchOverlays(page);

  let currentPage = page;
  if (!(await fastClaimSearchReady(currentPage))) {
    await stageLog("info", "claim-search", `Resetting Optum Pro Claim Search page ${reason}.`);
    currentPage = await returnToClaimSearch(currentPage, stageLog).catch(async (returnError) => {
      await stageLog("warn", "claim-search", `Could not return to Claim Search with state-driven navigation: ${returnError instanceof Error ? returnError.message : String(returnError)}`);
      return openClaimsSearch(currentPage, stageLog);
    });
  }

  if (!(await fastClaimSearchReady(currentPage))) {
    currentPage = await openClaimsSearch(currentPage, stageLog);
  }
  await timingLog?.(`${timingLabelPrefix}ensureClaimSearchReady`, ensureStartedAt);

  const formReadyStartedAt = Date.now();
  await clearClaimSearchFormIfVisible(currentPage).catch(() => {});
  await waitForClaimSearchFormControls(currentPage);
  await timingLog?.(`${timingLabelPrefix}claimSearchFormReady`, formReadyStartedAt);
  return currentPage;
}

async function cleanupClaimSearchAfterRow(
  page: Page,
  stageLog: StageLog,
  reason: string,
  timingLog?: RowTimingLog,
): Promise<Page> {
  await dismissClaimSearchOverlays(page);
  await clearClaimSearchFormIfVisible(page).catch(() => {});
  if (await fastClaimSearchReady(page)) {
    await stageLog("info", "claim-search", `Fast cleanup passed ${reason}.`);
    return page;
  }

  await stageLog("info", "claim-search", `Heavy Claim Search reset used ${reason}.`);
  return resetClaimSearchPage(page, stageLog, reason, timingLog, "cleanup.");
}

async function searchWithSelectedPatient(
  page: Page,
  row: OptumProInputRow,
  matchedPatient: string,
  stageLog: StageLog,
  timingLog?: RowTimingLog,
  checkCancellation?: CancellationCheck,
): Promise<OptumProSearchResult> {
  checkCancellation?.();
  const medicalGroupStartedAt = Date.now();
  const matchedGroup = await selectMedicalGroup(page, row.medicalGroupName, stageLog).catch(() => "");
  await timingLog?.("fillMedicalGroup", medicalGroupStartedAt);
  if (!matchedGroup) {
    await page.keyboard.press("Escape").catch(() => {});
    return emptyClaimResult(row, {
      matchedPatient,
      resultSummary: "No payer/group found",
      status: "No payer/group found",
      notes: `No valid medical group dropdown option found for ${row.medicalGroupName}.`,
    });
  }

  checkCancellation?.();
  const dateRangeStartedAt = Date.now();
  await setServiceDate(page, row.dos, stageLog);
  await timingLog?.("fillDateRange", dateRangeStartedAt);

  checkCancellation?.();
  const searchResultsStartedAt = Date.now();
  const searchButton = page.locator("button:has-text('Search')").last();
  await retryAfterBlockingPopup(page, stageLog, async () => {
    await searchButton.waitFor({ state: "visible", timeout: 30000 });
    await searchButton.click();
  });
  const resultSummary = await captureResultSummary(page);
  const resultRows = await claimResultRows(page);
  const resultRowCount = await resultRows.count().catch(() => 0);
  await timingLog?.("searchResults", searchResultsStartedAt);

  checkCancellation?.();
  if (!resultRowCount || /no result|0 results|no claims|no claims found/i.test(resultSummary) || await page.locator("text=/No Claims found/i").first().isVisible({ timeout: 500 }).catch(() => false)) {
    return emptyClaimResult(row, {
      matchedPatient,
      matchedGroup,
      resultSummary: resultSummary || "No Claims found",
      status: "No claims found",
      notes: "No claims found.",
    });
  }

  const processResultStartedAt = Date.now();
  const matchingClaim = await findMatchingClaimDetails(page, row, stageLog, checkCancellation);
  await timingLog?.("processResult", processResultStartedAt);
  if (!matchingClaim) {
    return emptyClaimResult(row, {
      matchedPatient,
      matchedGroup,
      resultSummary,
      status: "No matching CPT/service code found",
      notes: `No opened claim result contained CPT/service code ${row.cpt}.`,
    });
  }

  if (matchingClaim.status === "Completed") {
    await returnToClaimSearch(page, stageLog).catch((error) => {
      void stageLog("warn", "claim-search", `Could not return to Claim Search after detail extraction: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  return emptyClaimResult(row, {
    matchedPatient,
    matchedGroup,
    resultSummary: resultSummary || matchingClaim.clickedRowText,
    status: matchingClaim.status,
    notes: matchingClaim.notes || (matchingClaim.clickedRowText ? `Clicked result row: ${matchingClaim.clickedRowText}` : ""),
    ...matchingClaim.details,
  });
}

async function searchClaimRow(page: Page, row: OptumProInputRow, stageLog: StageLog, checkCancellation?: CancellationCheck): Promise<OptumProSearchResult> {
  await stageLog("info", "claim-search", `Processing Optum Pro input row ${row.rowNumber}: member ${row.memberId}, DOS ${row.dos}, medical group ${row.medicalGroupName}.`);
  checkCancellation?.();

  if (!row.memberId.trim()) {
    return emptyClaimResult(row, {
      memberId: "No Member Id Found",
      resultSummary: "No Member Id Found",
      status: "No Member Id Found",
      notes: "Input row did not contain a Member Id.",
    });
  }

  const timingLog: RowTimingLog = async (label, startedAt) => {
    await stageLog("info", "row-timing", `[row-timing] row ${row.rowNumber} ${label} took ${elapsedSeconds(startedAt)}s`);
  };
  const fillPatientStartedAt = Date.now();
  const selectedPatient = await selectPatient(page, row, "loose", stageLog).catch(() => null);
  await timingLog("fillPatient", fillPatientStartedAt);
  checkCancellation?.();
  if (!selectedPatient) {
    await stageLog("info", "claim-search", `No patient dropdown match found for row ${row.rowNumber}; skipping claim search for this row.`);
    await page.keyboard.press("Escape").catch(() => {});
    return emptyClaimResult(row, {
      resultSummary: "No patient found",
      status: "No patient found",
      notes: `No patient dropdown match found for Member Id ${row.memberId} / patient ${row.patient}.`,
    });
  }

  const exactResult = await searchWithSelectedPatient(page, row, selectedPatient.text, stageLog, timingLog, checkCancellation);
  if (exactResult.status !== "No claims found" || !selectedPatient.allowBlankSubscriberFallback) {
    return exactResult;
  }

  await clearClaimSearchFormIfVisible(page).catch(() => {});
  const fillPatientFallbackStartedAt = Date.now();
  const blankSubscriberPatient = await selectPatient(page, row, "blank-subscriber", stageLog).catch(() => null);
  await timingLog("fillPatientFallback", fillPatientFallbackStartedAt);
  checkCancellation?.();
  if (!blankSubscriberPatient) {
    return exactResult;
  }

  return searchWithSelectedPatient(page, row, blankSubscriberPatient.text, stageLog, timingLog, checkCancellation);
}

/**
 * Finds an element whose own (direct) text content exactly matches `label`,
 * then walks up its ancestor chain looking for the nearest element that
 * actually behaves like a clickable card (pointer cursor, button role,
 * onclick handler, or an icon/arrow rendered inside it) and clicks it.
 *
 * This is deliberately structure-agnostic: Optum has changed the CDO
 * selection modal's markup more than once (mat-dialog + ecp-ucl-card,
 * then a plain "Select your CDO" modal with div-based cards), and a
 * hard-coded selector breaks every time the markup shifts. Walking up
 * from the text node to the nearest clickable ancestor survives those
 * markup changes.
 */
async function clickCardByExactText(page: Page, label: string): Promise<boolean> {
  return page
    .evaluate((targetLabel) => {
      const clean = (value: string | null | undefined) => (value || "").replace(/\s+/g, " ").trim();
      const isVisible = (element: Element) => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      };

      const allElements = Array.from(document.querySelectorAll<HTMLElement>("body *"));
      const candidates = allElements.filter((element) => {
        if (!isVisible(element)) return false;
        const ownText = Array.from(element.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => clean(node.textContent))
          .join(" ");
        return ownText === targetLabel;
      });

      const isNativeInteractive = (node: HTMLElement): boolean =>
        node.tagName === "BUTTON" ||
        node.tagName === "A" ||
        node.getAttribute("role") === "button" ||
        node.hasAttribute("onclick");

      // shadcn/ui's default Card renders "rounded-lg ... border ... shadow-sm"; the CDO
      // option cards on this modal follow that pattern, so matching both class fragments
      // reliably identifies the card wrapper without depending on any specific hash suffix.
      const looksLikeCardContainer = (node: HTMLElement): boolean => {
        const className = typeof node.className === "string" ? node.className : "";
        return /rounded(-[a-z0-9]+)?/i.test(className) && /border/i.test(className);
      };

      const hasIconChild = (node: HTMLElement): boolean =>
        Boolean(node.querySelector("svg, [class*='arrow'], [class*='icon']"));

      for (const candidate of candidates) {
        // Pass 1: a genuinely interactive ancestor (button/link/role=button/onclick attr).
        // This is checked first because it's the only unambiguous signal.
        let node: HTMLElement | null = candidate;
        for (let depth = 0; depth < 8 && node; depth++) {
          if (isNativeInteractive(node)) {
            node.click();
            return true;
          }
          node = node.parentElement;
        }

        // Pass 2: a card-shaped container (rounded + bordered) that also holds an icon —
        // matches the "Select your CDO" option cards. `node !== candidate` skips the text
        // element itself; without that guard, `cursor: pointer` inherited down from some
        // far-off ancestor makes a bare <p>/<span> falsely look clickable (the original bug).
        node = candidate;
        for (let depth = 0; depth < 8 && node; depth++) {
          if (node !== candidate && looksLikeCardContainer(node) && hasIconChild(node)) {
            node.click();
            return true;
          }
          node = node.parentElement;
        }

        // Pass 3: fall back to the nearest ancestor with an icon/arrow child at all,
        // still skipping the text node itself.
        node = candidate;
        for (let depth = 0; depth < 8 && node; depth++) {
          if (node !== candidate && hasIconChild(node)) {
            node.click();
            return true;
          }
          node = node.parentElement;
        }
      }

      if (candidates[0]) {
        candidates[0].click();
        return true;
      }
      return false;
    }, label)
    .catch(() => false);
}

/**
 * Optum can remount the `claims-ui` iframe at any point during this
 * sequence — not just before `resolveClaimsFrame` returns, but also mid-CDO
 * click or while waiting for the Claim Search form to appear (see the
 * `resolveClaimsFrame` doc comment above). Rather than defensively wrapping
 * every intermediate `waitFor` inside `openClaimsSearchInFrame`, this outer
 * function catches a "Frame was detached" error from anywhere in that
 * sequence and simply re-runs the whole "resolve frame → CDO → wait for
 * form" flow once, which naturally re-resolves against whatever frame
 * Optum has settled on by then.
 */
async function openClaimsSearch(pageOrScope: Page, stageLog: StageLog): Promise<Page> {
  const rootPage = rootPageOf(pageOrScope);
  await stageLog("info", "claim-navigation", "Opening Optum Pro Claims menu.");
  await rootPage.locator("text=/Optum Pro portal|Hello,/i").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
  await clickWithBlockingPopupRetry(rootPage, stageLog, () => rootPage.locator("button:has-text('Claims'), a:has-text('Claims'), [role='button']:has-text('Claims')").first().click());

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await openClaimsSearchInFrame(rootPage, stageLog);
    } catch (error) {
      if (attempt === 2 || !isFrameDetachedError(error)) throw error;
      await stageLog("warn", "claim-navigation", "Optum Pro claims-ui iframe was replaced mid-navigation; re-resolving and retrying.");
    }
  }
  throw new Error("Unreachable: openClaimsSearch retry loop exited without returning or throwing.");
}

async function openClaimsSearchInFrame(rootPage: Page, stageLog: StageLog): Promise<Page> {
  const claimsFrame = await resolveClaimsFrame(rootPage, stageLog).catch(async (error) => {
    await stageLog("warn", "claim-navigation", `Could not detect the Optum Pro claims-ui iframe; falling back to top-level page. (${error instanceof Error ? error.message : String(error)})`);
    return null;
  });
  const scope = claimsFrame ? createClaimsScope(rootPage, claimsFrame) : rootPage;
  if (claimsFrame) {
    await stageLog("info", "claim-navigation", `Detected Optum Pro claims-ui iframe at ${claimsFrame.url()}.`);
  }

  const cdoModal = scope.locator("text=/Select your CDO/i").first();
  const patientFieldLocator = scope.locator(CLAIM_SEARCH_PATIENT_SELECTOR).first();

  // A single point-in-time `isVisible({ timeout: 15000 })` check races against the
  // claims-ui app's post-remount startup sequence (SET_NAVIGATION_CONTEXT ->
  // CLAIMS_OPEN_CLICK -> "Auto-opening CDO modal" postMessage round-trip), which can
  // easily take longer than 15s right after the iframe was torn down and re-resolved.
  // If that check loses the race, `cdoModalVisible` comes back false, the NAMM-click
  // block below is skipped entirely, and the code falls straight through to a 60s wait
  // on the patient field — which never appears because the CDO modal is still covering
  // it. Poll for both signals over a longer budget instead of taking one snapshot.
  let cdoModalVisible = false;
  let patientFieldAlreadyVisible = false;
  const detectionStartedAt = Date.now();
  while (Date.now() - detectionStartedAt < 45000) {
    cdoModalVisible = await cdoModal.isVisible({ timeout: 300 }).catch(() => false);
    if (cdoModalVisible) break;
    patientFieldAlreadyVisible = await patientFieldLocator.isVisible({ timeout: 300 }).catch(() => false);
    if (patientFieldAlreadyVisible) break;
    await scope.waitForTimeout(300);
  }
  if (!cdoModalVisible && !patientFieldAlreadyVisible) {
    await stageLog("warn", "claim-navigation", "Neither the CDO modal nor the Claim Search patient field appeared within 45s after the claims-ui iframe settled; proceeding to the final wait as a last resort.");
  }

  if (cdoModalVisible) {
    await stageLog("info", "claim-navigation", "CDO selection modal detected; selecting NAMM.");

    let nammClicked = false;
    for (let attempt = 1; attempt <= 3 && !nammClicked; attempt++) {
      nammClicked = await clickCardByExactText(scope, "NAMM");
      if (!nammClicked) {
        await scope.waitForTimeout(1000);
      }
    }

    if (!nammClicked) {
      await stageLog("warn", "claim-navigation", "Generic NAMM card click failed; trying direct locator fallback.");
      const nammOption = scope.getByText("NAMM", { exact: true }).first();
      if (await nammOption.isVisible({ timeout: 5000 }).catch(() => false)) {
        await clickWithBlockingPopupRetry(scope, stageLog, () => nammOption.click({ force: true }));
        nammClicked = true;
      }
    }

    if (!nammClicked) {
      await stageLog("error", "claim-navigation", "Could not click NAMM in the 'Select your CDO' modal.");
    } else {
      await cdoModal.waitFor({ state: "hidden", timeout: 30000 }).catch(async () => {
        await stageLog("warn", "claim-navigation", "'Select your CDO' modal did not close within 30s after clicking NAMM.");
      });
    }
  }

  await scope.locator(CLAIM_SEARCH_PATIENT_SELECTOR).first().waitFor({ state: "visible", timeout: 60000 });
  if (!INITIAL_FEEDBACK_DISMISS_CHECKED.has(rootPage)) {
    INITIAL_FEEDBACK_DISMISS_CHECKED.add(rootPage);
    await dismissOptumBlockingPopups(scope, stageLog);
  }
  await stageLog("info", "claim-navigation", "Optum Pro Claim Search page is ready.");
  return scope;
}

export async function runOptumProClaimSearch(
  page: Page,
  rows: OptumProInputRow[],
  context: ScraperContext,
  stageLog: StageLog,
): Promise<void> {
  let scope = await openClaimsSearch(page, stageLog);
  const results: Array<OptumProSearchResult | null> = rows.map(() => null);
  await context.emit({ type: "progress", completed: 0, total: rows.length });
  let previousRowEndedAt: number | null = null;
  let processedRows = 0;
  let stopped = false;
  let finalWorkbook: { path: string; buffer: Buffer; metadata: OptumProPartialJobMetadata } | null = null;

  const checkCancellation: CancellationCheck = () => {
    if (context.isCancelled?.()) {
      throw new OptumProStopRequestedError();
    }
  };

  const emitMetadata = async (metadata: OptumProPartialJobMetadata) => {
    await context.emit({
      type: "job_metadata",
      totalRows: metadata.totalRows,
      processedRows: metadata.processedRows,
      successfulRows: metadata.successfulRows,
      failedRows: metadata.failedRows,
      stopped: metadata.stopped,
      partialOutputAvailable: metadata.partialOutputAvailable,
    });
  };

  try {
    for (let index = 0; index < rows.length; index++) {
      checkCancellation();

      const row = rows[index];
      const rowStartedAt = Date.now();
      if (previousRowEndedAt !== null) {
        await stageLog("info", "row-timing", `[row-timing] gap before row ${row.rowNumber} was ${elapsedSeconds(previousRowEndedAt)}s`);
      }
      await stageLog("info", "row-timing", `[row-timing] row ${row.rowNumber} started at ${new Date(rowStartedAt).toISOString()}`);
      const timingLog: RowTimingLog = async (label, startedAt) => {
        await stageLog("info", "row-timing", `[row-timing] row ${row.rowNumber} ${label} took ${elapsedSeconds(startedAt)}s`);
      };

      try {
        if (!(await fastClaimSearchReady(scope, FAST_CLAIM_SEARCH_READY_TIMEOUT_MS, checkCancellation))) {
          scope = await resetClaimSearchPage(scope, stageLog, `before row ${row.rowNumber}`, timingLog);
        }
        checkCancellation();
        results[index] = await searchClaimRow(scope, row, stageLog, checkCancellation);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (isStopRequestedError(error)) {
          stopped = true;
          results[index] = emptyResultForRow(row, "Stopped during processing", "Stopped during processing");
          await stageLog("warn", "claim-search", "Current row marked as stopped during processing");
        } else {
          await stageLog("error", "claim-search", `Row ${row.rowNumber} failed: ${message}`);
          results[index] = emptyResultForRow(row, "error", message);
        }
      } finally {
        const cleanupStartedAt = Date.now();
        scope = await cleanupClaimSearchAfterRow(scope, stageLog, `after row ${row.rowNumber}`, timingLog).catch((error) => {
          void stageLog("warn", "claim-search", `Could not reset Claim Search after row ${row.rowNumber}: ${error instanceof Error ? error.message : String(error)}`);
          return scope;
        });
        await timingLog("cleanup", cleanupStartedAt);
        await timingLog("total", rowStartedAt);
        previousRowEndedAt = Date.now();
      }

      processedRows = results.filter(Boolean).length;
      finalWorkbook = await saveOptumProPartialWorkbook(context, rows, results, stopped);
      await stageLog("info", "claim-search", `Partial result saved after row ${row.rowNumber}`);
      await emitMetadata(finalWorkbook.metadata);
      await context.emit({ type: "progress", completed: processedRows, total: rows.length });

      if (stopped) {
        await stageLog("warn", "claim-search", "Stop requested; finalizing partial workbook");
        break;
      }
    }
  } catch (error) {
    if (isStopRequestedError(error)) {
      stopped = true;
      await stageLog("warn", "claim-search", "Stop requested; finalizing partial workbook");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await stageLog("error", "claim-search", `Unrecoverable Optum Pro claim search failure: ${message}`);
      finalWorkbook = await saveOptumProPartialWorkbook(context, rows, results, false);
      await emitMetadata(finalWorkbook.metadata);
      await stageLog("warn", "claim-search", "Partial output finalized after failure");
      await context.emit(downloadableWorkbookEvent("optum_pro_output_partial.xlsx", finalWorkbook.buffer));
      throw error;
    }
  }

  const completedAllRows = processedRows >= rows.length && !stopped;
  finalWorkbook = await saveOptumProPartialWorkbook(context, rows, results, stopped);
  await emitMetadata(finalWorkbook.metadata);

  if (stopped) {
    await stageLog("info", "claim-search", `Partial workbook ready: ${processedRows}/${rows.length} rows processed`);
    await context.emit(downloadableWorkbookEvent("optum_pro_output_partial.xlsx", finalWorkbook.buffer));
    await context.emit({ type: "cancelled", message: `Stopped. Partial workbook ready: ${processedRows}/${rows.length} rows processed.` });
    return;
  }

  await context.emit(downloadableWorkbookEvent(completedAllRows ? "optum_pro_output.xlsx" : "optum_pro_output_partial.xlsx", finalWorkbook.buffer));
}

function createOptumProOutputWorkbookBuffer(results: OptumProSearchResult[]): Buffer {
  const workbook = XLSX.utils.book_new();
  const rows = results.map((result) => ({
    ...result.input.raw,
    member_id: outputMemberId(result.memberId),
    result: result.status,
    matched_patient: outputValue(result.matchedPatient),
    matched_medical_group: outputValue(result.matchedGroup),
    claim_number: outputValue(result.claimNumber),
    claim_received_date: outputValue(result.claimReceivedDate),
    processed_date: outputValue(result.processedDate),
    service_code: outputValue(result.serviceCode),
    billed_amount: outputValue(result.billedAmount),
    plan_allowed_amount: outputValue(result.planAllowedAmount),
    patient_responsibility: outputValue(result.patientResponsibility),
    withhold_amount: outputValue(result.withholdAmount),
    denied_amount: outputValue(result.deniedAmount),
    paid_amount: outputValue(result.paidAmount),
    line_status: outputValue(result.lineStatus),
    explanation_code: outputValue(result.explanationCode),
    explanation_description: outputValue(result.explanationDescription),
    copay_amount: outputValue(result.copayAmount),
    coinsurance_amount: outputValue(result.coinsuranceAmount),
    deductible_amount: outputValue(result.deductibleAmount),
    payment_mode: outputValue(result.paymentMode),
    payment_type: outputValue(result.paymentType),
    eft_number: outputValue(result.eftNumber),
    eft_amount: outputValue(result.eftAmount),
    payment_date: outputValue(result.paymentDate),
    payment_id: outputValue(result.paymentId),
    payment_name: outputValue(result.paymentName),
    payee_name: outputValue(result.payeeName),
    result_summary: outputValue(result.resultSummary),
    notes: outputValue(result.notes),
    extracted_at: new Date().toISOString(),
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Output");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
