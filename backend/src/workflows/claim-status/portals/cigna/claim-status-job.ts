import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { ScraperContext } from "../../types";
import { launchCignaBrowser } from "./browser";
import { cignaConfig } from "./config";
import { normalizeCptCode, parseCignaInput, readCignaInputWorkbook, type CignaInputRow } from "./input";
import { createCignaOutputWorkbookBuffer, type CignaAuditRow, type CignaOutputRow, type CignaWorkbookState } from "./workbook";

type SearchResultRow = {
  claimNumber: string;
  claimStatus: string;
  patientName: string;
  dateOfBirth: string;
  datesOfService: string;
  providerAccountNumber: string;
  taxId: string;
  amountBilled: string;
  providerName: string;
  rowText: string;
};

type ProcedureLine = {
  procedureCode: string;
  datesOfService: string;
  placeOfService: string;
  amountCharged: string;
  allowedAmount: string;
  amountNotCovered: string;
  deductibleCopayApplied: string;
  coveredBalance: string;
  planCoinsurancePaid: string;
  patientCoinsurance: string;
  patientResponsibility: string;
  remarkCodes: string;
};

type ClaimDetails = {
  claimNumber: string;
  claimStatus: string;
  patientName: string;
  providerName: string;
  providerAccountNumber: string;
  dateReceived: string;
  dateProcessed: string;
  claimAmountDue: string;
  claimAmountPaid: string;
  totalProviderPayment: string;
  patientResponsibility: string;
  payment: {
    payeeName: string;
    payeeAddress: string;
    paymentAmount: string;
    remittanceTrackingNumber: string;
    paymentStatus: string;
    paymentIssued: string;
    paymentCleared: string;
    paymentMethod: string;
  };
  procedures: ProcedureLine[];
  remarkCodes: string;
};

const OUTPUT_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Adaptive-wait tuning. These replace blind fixed-length waits with polling
// loops that return as soon as the page shows either "results" or "no
// results" (instead of always waiting the full ms) but that will keep
// polling up to this ceiling for slow-loading pages (instead of timing out
// too early). If these ever need to be shared with other Cigna jobs, move
// them into cignaConfig.timing alongside betweenRowsMs/postSearchMs/etc.
const SEARCH_OUTCOME_POLL_MS = 300;
const SEARCH_OUTCOME_TIMEOUT_MS = 25000;
const CLAIM_ROW_TIMEOUT_MS = 20000;
const CLAIM_DETAIL_LOAD_TIMEOUT_MS = 20000;
const CLAIM_DETAIL_OPEN_ATTEMPTS = 3;
// The "Claim Search" breadcrumb link (see goBackToSearch) was previously
// only given 1500ms to appear before falling back to a full page reload.
// Claim detail pages can take longer than that to finish rendering, so the
// breadcrumb was frequently missed and the fallback reload fired on almost
// every row - resetting the search page to Cigna's default radio option
// ("Date of birth/Cigna patient ID") instead of preserving "Name/Cigna
// patient ID". Give it a real timeout, in line with the other detail-page
// waits in this file.
const CLAIM_SEARCH_BREADCRUMB_TIMEOUT_MS = 15000;

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function maskValue(value: string): string {
  const text = value.trim();
  if (text.length <= 4) return "****";
  return `${"*".repeat(text.length - 4)}${text.slice(-4)}`;
}

// Cigna's search rejects legal suffixes (Jr., Sr., II, III, IV...) packed
// into the Last name field even though the results table happily displays
// "Garcia III" - searching "Garcia III" returns 0 results while "Garcia"
// returns the real matches. Likewise a middle name/initial in First name
// ("Arthur J") can prevent a match. These helpers build a short, ordered
// list of name variants to retry the search with before giving up.
const NAME_SUFFIX_REGEX = /\s+(jr\.?|sr\.?|ii|iii|iv|v)\.?$/i;

function stripNameSuffix(name: string): string {
  return name.replace(NAME_SUFFIX_REGEX, "").trim();
}

function lastNameCandidates(lastName: string): string[] {
  const trimmed = cleanText(lastName || "");
  if (!trimmed) return [""];
  const candidates = [trimmed];
  const stripped = stripNameSuffix(trimmed);
  if (stripped && stripped !== trimmed) candidates.push(stripped);
  return candidates;
}

function firstNameCandidates(firstName: string): string[] {
  const trimmed = cleanText(firstName || "");
  if (!trimmed) return [""];
  const candidates = [trimmed];
  const firstToken = trimmed.split(" ")[0];
  if (firstToken && firstToken !== trimmed) candidates.push(firstToken);
  return candidates;
}

// Ordered, de-duplicated {first, last} pairs to try, cheapest/most-exact
// first. The Patient ID field never changes across attempts, so this only
// helps the search find the right patient - it can't widen the match to a
// different person.
function nameSearchAttempts(inputRow: CignaInputRow): Array<{ first: string; last: string }> {
  const lastNames = lastNameCandidates(inputRow.patientLastName);
  const firstNames = firstNameCandidates(inputRow.patientFirstName);
  const attempts: Array<{ first: string; last: string }> = [];
  const seen = new Set<string>();
  for (const last of lastNames) {
    for (const first of firstNames) {
      const key = `${first}||${last}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts.push({ first, last });
    }
  }
  return attempts;
}

function normalizeDateComparable(value: string): string {
  const text = value.trim();
  const match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!match) return text;
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  return `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function dateTextContains(inputDate: string, portalDateText: string): boolean {
  if (!inputDate) return true;
  const wanted = normalizeDateComparable(inputDate);
  return portalDateText
    .split(/[^0-9/.-]+/)
    .map(normalizeDateComparable)
    .includes(wanted);
}

function addAudit(state: CignaWorkbookState, inputRow: CignaInputRow | null, step: string, status: string, message: string): void {
  state.auditRows.push({
    timestamp: nowIso(),
    inputRowId: inputRow?.inputRowId ?? "",
    memberId: inputRow?.memberId ?? "",
    step,
    status,
    message,
  } satisfies CignaAuditRow);
}

function baseOutputRow(inputRow: CignaInputRow, botStatus: string, botMessage: string): CignaOutputRow {
  return {
    inputData: inputRow,
    inputRowId: inputRow.inputRowId,
    botStatus,
    botMessage,
    memberId: inputRow.memberId,
    patientFirstName: inputRow.patientFirstName,
    patientLastName: inputRow.patientLastName,
    dateOfBirth: inputRow.dateOfBirth,
    dos: inputRow.dos,
    cptCode: inputRow.cptCode,
    taxId: inputRow.taxId,
    claimNumber: "",
    claimStatus: "",
    patientName: "",
    providerName: "",
    providerAccountNumber: "",
    dateReceived: "",
    dateProcessed: "",
    datesOfService: "",
    amountBilled: "",
    claimAmountDue: "",
    claimAmountPaid: "",
    totalProviderPayment: "",
    patientResponsibility: "",
    payeeName: "",
    payeeAddress: "",
    paymentAmount: "",
    remittanceTrackingNumber: "",
    paymentStatus: "",
    paymentIssued: "",
    paymentCleared: "",
    paymentMethod: "",
    procedureCode: "",
    procedureDatesOfService: "",
    placeOfService: "",
    amountCharged: "",
    allowedAmount: "",
    amountNotCovered: "",
    deductibleCopayApplied: "",
    coveredBalance: "",
    planCoinsurancePaid: "",
    patientCoinsurance: "",
    patientResponsibilityLine: "",
    remarkCodes: "",
    explanationOfRemarkCodes: "",
    finalStatus: botMessage,
  };
}

function outputRowFromClaim(inputRow: CignaInputRow, result: SearchResultRow, details: ClaimDetails, procedure: ProcedureLine): CignaOutputRow {
  const finalStatus = cleanText(
    `DOS ${inputRow.dos || result.datesOfService}: Cigna claim ${details.claimNumber || result.claimNumber} ${details.claimStatus || result.claimStatus || "found"} matched CPT ${procedure.procedureCode}.`,
  );
  return {
    ...baseOutputRow(inputRow, "Success", "Claim found."),
    claimNumber: details.claimNumber || result.claimNumber,
    claimStatus: details.claimStatus || result.claimStatus,
    // Patient Name / Provider Generated Patient Account Number / Service
    // Providers are intentionally left blank - no longer captured per request.
    patientName: "",
    providerName: "",
    providerAccountNumber: "",
    dateReceived: details.dateReceived,
    dateProcessed: details.dateProcessed,
    datesOfService: result.datesOfService || procedure.datesOfService,
    amountBilled: result.amountBilled,
    claimAmountDue: details.claimAmountDue,
    claimAmountPaid: details.claimAmountPaid,
    totalProviderPayment: details.totalProviderPayment,
    patientResponsibility: details.patientResponsibility,
    payeeName: details.payment.payeeName,
    payeeAddress: details.payment.payeeAddress,
    paymentAmount: details.payment.paymentAmount,
    remittanceTrackingNumber: details.payment.remittanceTrackingNumber,
    paymentStatus: details.payment.paymentStatus,
    paymentIssued: details.payment.paymentIssued,
    paymentCleared: details.payment.paymentCleared,
    paymentMethod: details.payment.paymentMethod,
    procedureCode: procedure.procedureCode,
    procedureDatesOfService: procedure.datesOfService,
    placeOfService: procedure.placeOfService,
    amountCharged: procedure.amountCharged,
    allowedAmount: procedure.allowedAmount,
    amountNotCovered: procedure.amountNotCovered,
    deductibleCopayApplied: procedure.deductibleCopayApplied,
    coveredBalance: procedure.coveredBalance,
    planCoinsurancePaid: procedure.planCoinsurancePaid,
    patientCoinsurance: procedure.patientCoinsurance,
    patientResponsibilityLine: procedure.patientResponsibility,
    // Short code list from the Procedures table's own "Remark Codes" column, e.g. "PXN , MRZ".
    remarkCodes: procedure.remarkCodes,
    // Full "CODE - description" pairs from the claim-level Explanation of
    // Remark Codes section, one per code, joined with " || ".
    explanationOfRemarkCodes: details.remarkCodes,
    finalStatus,
  };
}

async function findVisibleLocator(page: Page, selector: string, timeout = 2500): Promise<Locator | null> {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: "visible", timeout });
    return locator;
  } catch {
    return null;
  }
}

async function clickIfVisible(page: Page, selector: string, timeout = 2500): Promise<boolean> {
  const locator = await findVisibleLocator(page, selector, timeout);
  if (!locator) return false;
  await locator.click({ timeout: 5000 }).catch(async () => locator.evaluate((element) => (element as HTMLElement).click()));
  await page.waitForTimeout(500);
  return true;
}

async function fillByLabel(page: Page, labelText: RegExp, value: string): Promise<boolean> {
  if (!value) return true;
  const locators = [
    page.getByLabel(labelText).first(),
    page.locator("label").filter({ hasText: labelText }).first().locator("xpath=following::input[1]"),
    page.locator(`input[aria-label*='${labelText.source.replace(/[^a-zA-Z ]/g, "")}' i]`).first(),
  ];
  for (const locator of locators) {
    try {
      await locator.waitFor({ state: "visible", timeout: 1200 });
      await locator.click({ timeout: 3000 });
      await locator.fill("");
      await locator.fill(value);
      return true;
    } catch {
      // Try the next locator.
    }
  }
  return false;
}

// Fills a field by an exact, unambiguous CSS selector (data-test-id based).
// Unlike fillByLabel/getByText, this never risks a Playwright "strict mode"
// match against multiple elements, which was silently swallowed before.
async function fillBySelector(page: Page, selector: string, value: string): Promise<boolean> {
  if (!value) return true;
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: "visible", timeout: 5000 });
    await locator.click({ timeout: 3000 });
    await locator.fill("");
    await locator.fill(value);
    return true;
  } catch {
    return false;
  }
}

async function selectRadio(page: Page, selector: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: "attached", timeout: 5000 });
    const checked = await locator.isChecked().catch(() => false);
    if (!checked) {
      await locator.check({ timeout: 5000, force: true }).catch(async () => {
        await locator.evaluate((element) => (element as HTMLInputElement).click());
      });
    }
    await page.waitForTimeout(400);
    return true;
  } catch {
    return false;
  }
}

async function visibleBodyText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
}

async function captureDiagnostics(context: ScraperContext, page: Page, inputRow: CignaInputRow | null, reason: string): Promise<void> {
  const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "error";
  const dir = path.join(process.cwd(), ".tmp", "cigna", context.jobId);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const rowLabel = inputRow ? `row-${inputRow.inputRowId}` : "job";
  const screenshotPath = path.join(dir, `${rowLabel}-${safeReason}.jpg`);
  const htmlPath = path.join(dir, `${rowLabel}-${safeReason}.html`);
  const screenshot = await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(htmlPath, html, "utf8").catch(() => {});
    await context.emit({ type: "debug_html", index: inputRow?.inputRowId, html, path: htmlPath, filename: `cigna_${rowLabel}_${safeReason}.html` });
  }
  if (screenshot) {
    await context.emit({ type: "error_screenshot", index: inputRow?.inputRowId, image: screenshot.toString("base64"), path: screenshotPath });
  }
}

async function submitOtp(page: Page, context: ScraperContext): Promise<void> {
  const timeoutMs = cignaConfig.timing.mfaWaitMs;
  await context.log({
    level: "info",
    message: "Cigna requires a verification code. Waiting for user to enter the code in the frontend.",
  });

  const codeInput = await findVisibleLocator(page, cignaConfig.selectors.otpInput, 15000);
  if (!codeInput) {
    // No OTP field appeared (maybe "remember this device" skipped it) - nothing to do.
    return;
  }

  const codePromise = waitForScrapeJobInput(context.jobId, "cigna_otp", timeoutMs);
  await context.emit({
    type: "input_request",
    inputName: "cigna_otp",
    label: "Cigna verification code",
    message: "Enter the 6-digit Cigna email verification code within 3 minutes.",
    timeoutMs,
  });

  const code = await codePromise;
  await codeInput.click({ timeout: 3000 }).catch(() => {});
  await codeInput.fill("");
  await codeInput.fill(code);
  await clickIfVisible(page, cignaConfig.selectors.otpContinue, 5000);

  await page.waitForURL(/cignaforhcp\.cigna\.com\/app\//i, { timeout: cignaConfig.timing.mfaWaitMs }).catch(() => {});
}

async function login(page: Page, input: Awaited<ReturnType<typeof parseCignaInput>>, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Cigna for Health Care Professionals login page." });
  await page.goto(input.credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await clickIfVisible(page, cignaConfig.selectors.cookieClose, 1500);
  if (!(await findVisibleLocator(page, cignaConfig.selectors.username, 1500))) {
    await clickIfVisible(page, cignaConfig.selectors.homeLoginButton, 10000);
  }
  await findVisibleLocator(page, cignaConfig.selectors.username, 30000);
  await fillByLabel(page, /username/i, input.credentials.username);
  await context.log({ level: "info", message: "Submitting Cigna username." });
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    clickIfVisible(page, cignaConfig.selectors.usernameNext, 5000),
  ]);
  await findVisibleLocator(page, cignaConfig.selectors.password, 30000);
  await fillByLabel(page, /password/i, input.credentials.password);
  await context.log({ level: "info", message: "Submitting Cigna password." });
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    clickIfVisible(page, cignaConfig.selectors.passwordContinue, 5000),
  ]);
  await page.waitForTimeout(cignaConfig.timing.postLoginMs);

  const bodyText = await visibleBodyText(page);
  if (/verify your identity|enter 6-digit code|remember this device/i.test(bodyText)) {
    await submitOtp(page, context);
  }

  if (await findVisibleLocator(page, cignaConfig.selectors.password, 1000)) {
    throw new Error("Cigna login failed or did not leave the password page.");
  }
  await context.log({ level: "info", message: "Cigna login completed." });
}

async function openClaimSearch(page: Page, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Cigna Claims search page." });
  await page.goto(cignaConfig.claimSearchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await findVisibleLocator(page, cignaConfig.selectors.claimSearchHeading, 30000);
}

async function clearSearch(page: Page): Promise<void> {
  if (await clickIfVisible(page, cignaConfig.selectors.clearAll, 1200)) {
    await page.waitForTimeout(700);
    return;
  }
  await page.goto(cignaConfig.claimSearchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await findVisibleLocator(page, cignaConfig.selectors.claimSearchHeading, 30000);
}

// Polls the page after clicking Search instead of doing one blind fixed
// wait. Returns as soon as either a result row or the "no results" empty
// state shows up (fast when Cigna is fast), but keeps polling up to
// SEARCH_OUTCOME_TIMEOUT_MS for slow loads (instead of a hard 10s timeout
// that fires while the table is still rendering).
async function waitForSearchOutcome(page: Page): Promise<"results" | "empty" | "timeout"> {
  const rowLocator = page.locator(`${cignaConfig.selectors.resultsBody} tr`).first();
  const emptyLocator = page.getByText(/no results for the parameters chosen/i).first();
  const deadline = Date.now() + SEARCH_OUTCOME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await rowLocator.isVisible().catch(() => false)) return "results";
    if (await emptyLocator.isVisible().catch(() => false)) return "empty";
    await page.waitForTimeout(SEARCH_OUTCOME_POLL_MS);
  }
  return "timeout";
}

async function fillNameFields(page: Page, firstName: string, lastName: string, context: ScraperContext, rowId: string): Promise<void> {
  // Fill by exact data-test-id selectors (not label text) so we never hit
  // Cigna's duplicate/mismatched <label for> markup on this form.
  const firstNameFilled = await fillBySelector(page, cignaConfig.selectors.firstName, firstName);
  const lastNameFilled = await fillBySelector(page, cignaConfig.selectors.lastName, lastName);
  if (firstName && !firstNameFilled) {
    await context.log({ level: "warn", message: "Could not fill First name field.", rowIndex: rowId });
  }
  if (lastName && !lastNameFilled) {
    await context.log({ level: "warn", message: "Could not fill Last name field.", rowIndex: rowId });
  }
}

async function runSearchAttempt(
  page: Page,
  inputRow: CignaInputRow,
  firstName: string,
  lastName: string,
  context: ScraperContext,
): Promise<SearchResultRow[]> {
  await fillNameFields(page, firstName, lastName, context, inputRow.inputRowId);
  const memberIdFilled = await fillBySelector(page, cignaConfig.selectors.memberId, inputRow.memberId);
  if (!memberIdFilled) throw new Error("Could not fill the Cigna Patient ID field.");

  const clicked = await clickIfVisible(page, cignaConfig.selectors.searchButton, 8000);
  if (!clicked) throw new Error("Could not click the Cigna Search button.");

  const outcome = await waitForSearchOutcome(page);
  if (outcome === "empty") return [];
  if (outcome === "timeout") {
    await context
      .log({
        level: "warn",
        message: `Cigna search results took longer than ${SEARCH_OUTCOME_TIMEOUT_MS}ms for row ${inputRow.inputRowId}; reading whatever loaded.`,
        rowIndex: inputRow.inputRowId,
      })
      .catch(() => {});
  }
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return extractSearchRows(page);
}

async function submitSearch(page: Page, inputRow: CignaInputRow, context: ScraperContext): Promise<SearchResultRow[]> {
  await clearSearch(page);

  // Select the "Name/Cigna patient ID" radio by its exact id/data-test-id.
  // (Previously this used page.getByText(...) with no .first(), which matched
  // several nested elements at once, threw a Playwright strict-mode error,
  // and was silently swallowed - so the radio was never actually selected.)
  const radioSelected = await selectRadio(page, cignaConfig.selectors.searchTypeIdName);
  if (!radioSelected) {
    await context.log({
      level: "warn",
      message: "Could not select the 'Name/Cigna patient ID' search option; attempting to fill fields anyway.",
      rowIndex: inputRow.inputRowId,
    });
  }

  // Try the name as given first, then progressively simplified variants
  // (suffix stripped from last name, middle name/initial dropped from first
  // name) if the exact name comes back empty. The Patient ID is identical
  // on every attempt, so this can only help find the same patient - it
  // can never match a different one.
  const attempts = nameSearchAttempts(inputRow);
  let lastResults: SearchResultRow[] = [];
  for (let i = 0; i < attempts.length; i += 1) {
    const { first, last } = attempts[i];
    await context.log({
      level: "info",
      message: `Searching Cigna row ${inputRow.inputRowId}: ${last || "(blank)"}, ${first || "(blank)"}, member ${maskValue(inputRow.memberId)}${
        i > 0 ? " [fallback name variant]" : ""
      }.`,
      rowIndex: inputRow.inputRowId,
    });
    lastResults = await runSearchAttempt(page, inputRow, first, last, context);
    if (lastResults.length) return lastResults;
  }
  return lastResults;
}

async function extractSearchRows(page: Page): Promise<SearchResultRow[]> {
  return page.evaluate((cfg) => {
    function clean(value: string | null | undefined): string {
      return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
    function cellText(row: Element, testId: string): string {
      return clean(row.querySelector(`[data-test-id='${testId}']`)?.textContent);
    }
    const table = document.querySelector(cfg.resultsTable);
    if (!table) return [];
    const bodyRows = Array.from(table.querySelectorAll(`${cfg.resultsBody} tr`));
    return bodyRows
      .map((row) => {
        const link = row.querySelector<HTMLAnchorElement>("[data-test-id='c360-result-table-claimRefNumber-cell'] a");
        const nameCell = row.querySelector("[data-test-id='c360-result-table-name-cell']");
        const patientName = clean(nameCell?.querySelector("div")?.textContent);
        return {
          claimNumber: clean(link?.textContent),
          claimStatus: cellText(row, "c360-result-table-claimStatus-cell"),
          patientName,
          dateOfBirth: cellText(row, "c360-result-table-patientDOB-cell"),
          datesOfService: cellText(row, "c360-result-table-dos-cell"),
          providerAccountNumber: cellText(row, "c360-result-table-providerAcct-cell"),
          taxId: cellText(row, "c360-result-table-tin-cell"),
          amountBilled: cellText(row, "c360-result-table-amtBill-cell"),
          providerName: cellText(row, "c360-result-table-providerName-cell"),
          rowText: clean(row.textContent),
        };
      })
      .filter((row) => row.claimNumber);
  }, cignaConfig.selectors);
}

function rowMatchesInput(row: SearchResultRow, inputRow: CignaInputRow): boolean {
  const dosMatches = !inputRow.dos || dateTextContains(inputRow.dos, row.datesOfService || row.rowText);
  const memberMatches = !inputRow.memberId || row.rowText.replace(/\s+/g, "").toUpperCase().includes(inputRow.memberId.toUpperCase());
  const tinMatches = !inputRow.taxId || row.rowText.replace(/\D+/g, "").includes(inputRow.taxId);
  return dosMatches && memberMatches && tinMatches;
}

async function openClaimDetail(page: Page, result: SearchResultRow, context: ScraperContext): Promise<void> {
  const rowLocator = page.locator(`${cignaConfig.selectors.resultsBody} tr`).filter({ hasText: result.claimNumber });
  const linkLocator = rowLocator.locator("[data-test-id='c360-result-table-claimRefNumber-cell'] a").first();

  let lastError: unknown;
  for (let attempt = 1; attempt <= CLAIM_DETAIL_OPEN_ATTEMPTS; attempt += 1) {
    try {
      // Wait for the specific row to actually be visible before clicking -
      // this is what was firing "Timeout 10000ms exceeded" when the table
      // was still rendering after search.
      await rowLocator.first().waitFor({ state: "visible", timeout: CLAIM_ROW_TIMEOUT_MS });
      await linkLocator.waitFor({ state: "visible", timeout: CLAIM_ROW_TIMEOUT_MS });
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
        linkLocator.click({ timeout: CLAIM_ROW_TIMEOUT_MS }),
      ]);
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
      // Confirm the detail page actually rendered (not just navigated) before
      // treating this as success, instead of a blind fixed-length wait.
      const loaded = await findVisibleLocator(page, "[data-test-id='claim-reference-number']", CLAIM_DETAIL_LOAD_TIMEOUT_MS);
      if (!loaded) throw new Error("Claim detail page did not render after clicking the claim link.");
      return;
    } catch (error) {
      lastError = error;
      await context
        .log({
          level: "warn",
          message: `Attempt ${attempt}/${CLAIM_DETAIL_OPEN_ATTEMPTS} to open claim ${result.claimNumber} failed: ${errorMessage(error)}`,
        })
        .catch(() => {});
      if (attempt < CLAIM_DETAIL_OPEN_ATTEMPTS) await page.waitForTimeout(1000);
    }
  }
  throw new Error(`Could not open claim detail for ${result.claimNumber}: ${errorMessage(lastError)}`);
}

async function extractClaimDetails(page: Page, fallback: SearchResultRow): Promise<ClaimDetails> {
  return page.evaluate((fallbackRow) => {
    function clean(value: string | null | undefined): string {
      return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
    function byTestId(testId: string): string {
      return clean(document.querySelector(`[data-test-id='${testId}']`)?.textContent);
    }

    // Payee/payment table: read by header text -> column index, since Cigna's
    // own data-test-ids on these cells (payment-method2/3, check-*) don't
    // line up with their header names.
    const payeeTable = document.querySelector("[data-test-id='payee-info-table']");
    const payeeHeaders = payeeTable
      ? Array.from(payeeTable.querySelectorAll("thead th")).map((th) => clean(th.textContent).toLowerCase())
      : [];
    const payeeRow = payeeTable?.querySelector("tbody tr");
    const payeeCells = payeeRow ? Array.from(payeeRow.querySelectorAll("td")) : [];
    function payeeValue(headerNeedle: string): string {
      const index = payeeHeaders.findIndex((header) => header.includes(headerNeedle));
      return index >= 0 ? clean(payeeCells[index]?.textContent) : "";
    }

    // Procedures table: one row per CPT line (there may be several).
    const procedureRows = Array.from(document.querySelectorAll("[data-test-id='procedures-table-row']"));
    const procedures = procedureRows.map((row) => {
      const cell = (testId: string) => clean(row.querySelector(`[data-test-id='${testId}']`)?.textContent);
      const planCoinsurancePaid = clean(
        row.querySelector("[data-test-id='svc-line-paid-amount']")?.textContent ||
          row.querySelector("[data-test-id='plan-coinsurance-or-svc-line-paid']")?.textContent,
      );
      return {
        procedureCode: cell("procedure-code"),
        datesOfService: cell("date-of-service"),
        placeOfService: cell("place-of-sevice"),
        amountCharged: cell("amount-charged"),
        allowedAmount: cell("allowed-amount"),
        amountNotCovered: cell("amount-not-covered"),
        deductibleCopayApplied: cell("deductible"),
        coveredBalance: cell("covered-balance"),
        planCoinsurancePaid,
        patientCoinsurance: cell("member-coinsurance-per"),
        patientResponsibility: cell("member-responsibility"),
        // The Procedures table's own "Remark Codes" cell, e.g. "PXN , MRZ".
        remarkCodes: cell("remark-code"),
      };
    });

    // Explanation of Remark Codes section can list several codes, each as its
    // own CODE block followed by its own description block (both share the
    // same data-test-id per instance, so querySelectorAll + zip by index).
    const remarkCodeNodes = Array.from(document.querySelectorAll("[data-test-id='lbl-claims-remark-code-msg']"));
    const remarkDescNodes = Array.from(document.querySelectorAll("[data-test-id='lbl-claims-remark-code-desc-msg']"));
    const remarkPairs: string[] = [];
    for (let i = 0; i < Math.max(remarkCodeNodes.length, remarkDescNodes.length); i += 1) {
      const code = clean(remarkCodeNodes[i]?.textContent);
      const description = clean(remarkDescNodes[i]?.textContent);
      if (!code && !description) continue;
      remarkPairs.push(code && description ? `${code} - ${description}` : code || description);
    }
    const remarkCodes = remarkPairs.join(" || ");

    return {
      claimNumber: byTestId("claim-reference-number") || fallbackRow.claimNumber,
      claimStatus: byTestId("claim-status") || fallbackRow.claimStatus,
      patientName: byTestId("member-name") || fallbackRow.patientName,
      providerName: byTestId("serice-provider") || fallbackRow.providerName,
      providerAccountNumber: byTestId("provider-generated-patient-acc-number") || fallbackRow.providerAccountNumber,
      dateReceived: byTestId("date-received"),
      dateProcessed: byTestId("date-processed"),
      claimAmountDue: byTestId("claim-amount-due"),
      claimAmountPaid: byTestId("total-paid-amount"),
      totalProviderPayment: byTestId("payment-provider-amount"),
      patientResponsibility: byTestId("patient-responsibility"),
      payment: {
        payeeName: payeeValue("payee's name") || payeeValue("payee name"),
        payeeAddress: payeeValue("payee's address") || payeeValue("payee address"),
        paymentAmount: payeeValue("payment amount"),
        remittanceTrackingNumber: payeeValue("remittance tracking"),
        paymentStatus: payeeValue("payment status"),
        paymentIssued: payeeValue("payment issued"),
        paymentCleared: payeeValue("payment cleared"),
        paymentMethod: payeeValue("payment method"),
      },
      procedures,
      remarkCodes,
    };
  }, fallback);
}

function findMatchingProcedures(details: ClaimDetails, inputRow: CignaInputRow): ProcedureLine[] {
  const cpt = normalizeCptCode(inputRow.cptCode);
  return details.procedures.filter((procedure) => normalizeCptCode(procedure.procedureCode) === cpt);
}

async function goBackToSearch(page: Page, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Returning to Cigna Claim Search page." }).catch(() => {});
  const clickedBreadcrumb = await clickIfVisible(
    page,
    cignaConfig.selectors.claimSearchBreadcrumb,
    CLAIM_SEARCH_BREADCRUMB_TIMEOUT_MS,
  );
  if (clickedBreadcrumb) {
    await context.log({ level: "info", message: "Clicked the 'Claim Search' breadcrumb link." }).catch(() => {});
  } else {
    await context
      .log({
        level: "warn",
        message: "Could not find the 'Claim Search' breadcrumb link; reloading the Claim Search page directly instead.",
      })
      .catch(() => {});
    await page.goto(cignaConfig.claimSearchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  await findVisibleLocator(page, cignaConfig.selectors.claimSearchHeading, 30000);
  // Deliberately NOT calling clearSearch() here. goBackToSearch() is used
  // inside processRow's candidate loop to return to the *same* results list
  // so the next candidate claim can be opened - it is not "start a new
  // search". clearSearch() clicks Cigna's "Clear all"/reset control, which
  // wipes the results table and resets the search-type radio back to
  // Cigna's default "Date of birth/Cigna patient ID". That's exactly what
  // was causing the reported symptoms: landing back on the Date of
  // birth/Cigna patient ID section (no name fields to fill), and the next
  // candidate claim number then timing out in openClaimDetail() - the row
  // wasn't stale, it had actually been cleared out. submitSearch() already
  // calls clearSearch() itself at the start of every new input row, so
  // nothing is lost by not also clearing here.
}

async function processRow(page: Page, inputRow: CignaInputRow, state: CignaWorkbookState, context: ScraperContext): Promise<void> {
  if (!inputRow.memberId) {
    state.outputRows.push(baseOutputRow(inputRow, "No Member ID", "No Member ID"));
    addAudit(state, inputRow, "validation", "failed", "No Member ID");
    return;
  }
  if (inputRow.validationStatus !== "valid") {
    state.outputRows.push(baseOutputRow(inputRow, "Invalid Row", inputRow.validationMessage));
    addAudit(state, inputRow, "validation", "failed", inputRow.validationMessage);
    return;
  }

  addAudit(state, inputRow, "search", "started", "Submitting Cigna claim search.");
  const searchRows = await submitSearch(page, inputRow, context);
  if (!searchRows.length) {
    const pageText = await visibleBodyText(page);
    const status = /member not found|patient not found/i.test(pageText) ? "Member Not Found" : "No Claims Found";
    state.outputRows.push(baseOutputRow(inputRow, status, status));
    addAudit(state, inputRow, "search", "completed", status);
    return;
  }

  const matchingRows = searchRows.filter((row) => rowMatchesInput(row, inputRow));
  const rowsToCheck = matchingRows.length ? matchingRows : searchRows;
  await context.log({
    level: "info",
    message: `Cigna row ${inputRow.inputRowId}: found ${searchRows.length} result(s), checking ${rowsToCheck.length} candidate claim(s).`,
    rowIndex: inputRow.inputRowId,
  });

  for (const result of rowsToCheck) {
    let detailOpened = false;
    try {
      await openClaimDetail(page, result, context);
      detailOpened = true;
      const details = await extractClaimDetails(page, result);
      const procedures = findMatchingProcedures(details, inputRow);
      if (procedures.length) {
        for (const procedure of procedures) state.outputRows.push(outputRowFromClaim(inputRow, result, details, procedure));
        addAudit(state, inputRow, "detail", "completed", `Matched claim ${details.claimNumber || result.claimNumber} and CPT ${inputRow.cptCode}.`);
        return;
      }
      await context.log({
        level: "warn",
        message: `CPT ${inputRow.cptCode} not found in Cigna claim ${details.claimNumber || result.claimNumber}.`,
        rowIndex: inputRow.inputRowId,
      });
    } catch (error) {
      // A single candidate claim failing to open (timeout, stale row, etc.)
      // should not abort every other candidate for this row - log it and
      // move on to the next one instead.
      const message = errorMessage(error);
      await context
        .log({
          level: "warn",
          message: `Could not open/read Cigna claim ${result.claimNumber} for row ${inputRow.inputRowId}: ${message}. Trying next candidate.`,
          rowIndex: inputRow.inputRowId,
        })
        .catch(() => {});
      addAudit(state, inputRow, "detail", "warning", `Could not open claim ${result.claimNumber}: ${message}`);
    } finally {
      if (context.isCancelled?.()) {
        // no-op, loop will exit on next iteration check upstream
      } else if (detailOpened) {
        await goBackToSearch(page, context);
      } else {
        // The click/open itself failed, possibly leaving the page in an
        // unknown state - make sure we're back on a usable search page
        // before trying the next candidate claim.
        await openClaimSearch(page, context).catch(() => {});
      }
    }
  }

  state.outputRows.push(baseOutputRow(inputRow, "CPT not found in Procedures", `CPT not found in Procedures: ${inputRow.cptCode}.`));
  addAudit(state, inputRow, "detail", "completed", `No procedure matched CPT ${inputRow.cptCode}.`);
}

async function emitArtifacts(context: ScraperContext, state: CignaWorkbookState): Promise<void> {
  const workbookBuffer = await createCignaOutputWorkbookBuffer(state);
  await context.emit({
    type: "file_download",
    filename: "cigna_output.xlsx",
    base64: workbookBuffer.toString("base64"),
    mimeType: OUTPUT_MIME,
  });
  const logContent = state.auditRows.map((row) => `[${row.timestamp}] row=${row.inputRowId} ${row.step} ${row.status}: ${row.message}`).join("\n");
  await context.emit({
    type: "file_download",
    filename: "cigna-run.log",
    base64: Buffer.from(logContent, "utf8").toString("base64"),
    mimeType: "text/plain",
  });
}

export async function runCignaClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parseCignaInput(formData);
  const rows = readCignaInputWorkbook(input.inputWorkbookBuffer);
  const state: CignaWorkbookState = { outputRows: [], auditRows: [] };
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    await context.log({ level: "info", message: `Cigna input loaded: ${rows.length} row(s).` });
    await context.emit({ type: "progress", completed: 0, total: rows.length });
    browser = await launchCignaBrowser((message) => context.log({ level: "info", message }));
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await login(page, input, context);
    await openClaimSearch(page, context);

    let completed = 0;
    for (const row of rows) {
      if (context.isCancelled?.()) {
        await context.log({ level: "warn", message: "Cigna run stopped by user. Creating partial output." });
        await context.emit({ type: "cancelled", message: "Cigna scraping stopped. Partial workbook downloaded." });
        break;
      }
      try {
        await processRow(page, row, state, context);
      } catch (error) {
        const message = errorMessage(error);
        state.outputRows.push(baseOutputRow(row, "Portal Error", message));
        addAudit(state, row, "row_processing", "failed", message);
        if (page) await captureDiagnostics(context, page, row, "row-error");
        if (page) await openClaimSearch(page, context).catch(() => {});
      }
      completed += 1;
      await context.emit({ type: "progress", completed, total: rows.length });
      await page.waitForTimeout(cignaConfig.timing.betweenRowsMs);
    }

    await emitArtifacts(context, state);
    await context.emit({ type: "done" });
  } catch (error) {
    const message = errorMessage(error);
    addAudit(state, null, "job", "failed", message);
    await context.log({ level: "error", message: `Cigna run failed: ${message}` });
    if (page) await captureDiagnostics(context, page, null, "job-error");
    await emitArtifacts(context, state).catch(() => {});
    await context.emit({ type: "error", message });
    await context.emit({ type: "done" });
  } finally {
    await closeAutomationResources({
      browser,
      page,
      log: (message: string) => context.log({ level: "info", message }),
    });
  }
}
