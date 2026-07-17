import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
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
  await context.log({
    level: "warn",
    message: "Cigna requires a verification code. Enter the code on the run screen to continue.",
  });

  // Ask the frontend to prompt the user for the OTP, exactly like the Optum
  // portal does. requestOtp() should resolve with the code once the user
  // types it in the run screen. This is cast through `unknown` because
  // ScraperContext's shared type (../../types) hasn't been shown to us -
  // point this at whatever method Optum's job.ts actually calls
  // (e.g. requestOtp / waitForOtp / promptForCode) so the two portals share
  // one contract.
  const otpAwareContext = context as unknown as {
    requestOtp?: (options: { message: string }) => Promise<string | null>;
  };
  const otpCode = await otpAwareContext.requestOtp?.({ message: "Enter the 6-digit Cigna verification code." }).catch(() => null) ?? null;

  const codeInput = await findVisibleLocator(page, cignaConfig.selectors.otpInput, 15000);
  if (!codeInput) {
    // No OTP field appeared (maybe "remember this device" skipped it) - nothing to do.
    return;
  }

  if (otpCode) {
    await codeInput.click({ timeout: 3000 }).catch(() => {});
    await codeInput.fill("");
    await codeInput.fill(otpCode);
    await clickIfVisible(page, cignaConfig.selectors.otpContinue, 5000);
  } else {
    // Fallback: no frontend OTP channel wired up yet - wait for the person to
    // type the code directly into the visible browser window.
    await context.log({
      level: "warn",
      message: "No OTP received from the run screen; waiting for the code to be entered in the visible browser instead.",
    });
  }

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

  // Fill by exact data-test-id selectors (not label text) so we never hit
  // Cigna's duplicate/mismatched <label for> markup on this form.
  const firstNameFilled = await fillBySelector(page, cignaConfig.selectors.firstName, inputRow.patientFirstName);
  const lastNameFilled = await fillBySelector(page, cignaConfig.selectors.lastName, inputRow.patientLastName);
  const memberIdFilled = await fillBySelector(page, cignaConfig.selectors.memberId, inputRow.memberId);

  if (!memberIdFilled) {
    throw new Error("Could not fill the Cigna Patient ID field.");
  }
  if (inputRow.patientFirstName && !firstNameFilled) {
    await context.log({ level: "warn", message: "Could not fill First name field.", rowIndex: inputRow.inputRowId });
  }
  if (inputRow.patientLastName && !lastNameFilled) {
    await context.log({ level: "warn", message: "Could not fill Last name field.", rowIndex: inputRow.inputRowId });
  }

  await context.log({
    level: "info",
    message: `Searching Cigna row ${inputRow.inputRowId}: ${inputRow.patientLastName}, ${inputRow.patientFirstName}, member ${maskValue(inputRow.memberId)}.`,
    rowIndex: inputRow.inputRowId,
  });

  const clicked = await clickIfVisible(page, cignaConfig.selectors.searchButton, 8000);
  if (!clicked) throw new Error("Could not click the Cigna Search button.");
  await page.waitForTimeout(cignaConfig.timing.postSearchMs);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  return extractSearchRows(page);
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

async function openClaimDetail(page: Page, result: SearchResultRow): Promise<void> {
  const link = page
    .locator(`${cignaConfig.selectors.resultsBody} tr`)
    .filter({ hasText: result.claimNumber })
    .locator("[data-test-id='c360-result-table-claimRefNumber-cell'] a")
    .first();
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    link.click({ timeout: 10000 }),
  ]);
  await page.waitForTimeout(cignaConfig.timing.detailLoadMs);
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
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
  if (!(await clickIfVisible(page, cignaConfig.selectors.claimSearchBreadcrumb, 1500))) {
    await page.goto(cignaConfig.claimSearchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  await findVisibleLocator(page, cignaConfig.selectors.claimSearchHeading, 30000);
  await clearSearch(page);
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
      await openClaimDetail(page, result);
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
    } finally {
      if (detailOpened && !context.isCancelled?.()) await goBackToSearch(page, context);
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