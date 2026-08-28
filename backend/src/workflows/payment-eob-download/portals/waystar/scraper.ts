import fs from "node:fs/promises";
import path from "node:path";
import type { Download, Locator, Page } from "playwright-core";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { getJobDataPath } from "@/backend/src/core/storage";
import type { AutomationContext, AutomationRunner } from "../../../types";
import type { PaymentEobRunInput } from "../../types";
import { loginToWaystarClaimStatus } from "../../../claim-status/portals/waystar/portal";
import { createStoredZipFromFolder } from "../availity-remittance/zip";
import { waystarPaymentEobConfig } from "./config";
import { isEligibleWaystarControlRow, isUsableCheckNumber, normalizeAmount, normalizePaymentNumber, readWaystarControlLog, readWaystarPaymentCredentials } from "./input";
import { buildWaystarSearchResults, buildWaystarZeroPayments } from "./output-builder";
import type { WaystarControlLogRow, WaystarPaymentCredentials, WaystarPaymentRecord, WaystarSearchResult, WaystarZeroPaymentOutputRow } from "./types";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) throw new Error(`${label} is required.`);
  return value;
}

function datePart(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function safePart(value: string): string { return value.trim().replace(/[<>:"/\\|?*]/g, "_") || "payment"; }

function normalizedAccountText(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function chooseAccountMatch(accountNames: string[], searchText: string): { index: number; name: string } {
  const wanted = normalizedAccountText(searchText);
  const candidates = accountNames
    .map((name, index) => ({ index, name: name.trim(), normalized: normalizedAccountText(name) }))
    .filter((candidate) => candidate.normalized.includes(wanted));

  const exact = candidates.filter((candidate) => candidate.normalized === wanted);
  if (exact.length === 1) return exact[0];

  // Prefer account codes/names at the beginning, for example "AHK - ..." or
  // "Posada Ambulatory ...", over incidental matches later in an account name.
  const prefix = candidates.filter((candidate) => {
    if (!candidate.normalized.startsWith(wanted)) return false;
    const nextCharacter = candidate.normalized.charAt(wanted.length);
    return !nextCharacter || /[\s\-(]/.test(nextCharacter);
  });
  if (prefix.length === 1) return prefix[0];
  if (candidates.length === 1) return candidates[0];

  const ambiguous = prefix.length > 1 ? prefix : candidates;
  if (ambiguous.length > 1) {
    throw new Error(`Waystar account search "${searchText}" matched multiple accounts: ${ambiguous.map((candidate) => candidate.name).join("; ")}. Use a more specific account value.`);
  }
  throw new Error(`No Waystar account matched "${searchText}".`);
}

async function selectAccount(page: Page, credentials: WaystarPaymentCredentials, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: `Checking Waystar account selection for ${credentials.account}.`, eventName: "waystar_payment_account_check" });
  const current = page.locator(".header-account-search-text").first();
  await current.waitFor({ state: "visible", timeout: 60000 });
  const currentValue = (await current.inputValue().catch(() => "")).trim();
  if (currentValue.toLowerCase().includes(credentials.account.toLowerCase())) {
    await context.log({ level: "info", message: `Waystar account ${currentValue} is already selected.`, eventName: "waystar_payment_account_selected" });
    return;
  }

  await page.locator("#hdrAcctChildSearchLnk").click();
  const input = page.locator("#accountSearchChildModal .header-account-search-input").first();
  await input.fill(credentials.account);
  await page.locator("#accountSearchChildButton").click();
  const results = page.locator("#accountSearchChildModal a.change-account-link");
  await page.waitForFunction((searchText) => {
    const wanted = String(searchText).trim().toLowerCase();
    return [...document.querySelectorAll("#accountSearchChildModal a.change-account-link")]
      .some((element) => (element.textContent ?? "").trim().toLowerCase().includes(wanted));
  }, credentials.account, { timeout: 30000 }).catch(() => {});

  const visibleResults: Array<{ locator: Locator; name: string }> = [];
  for (let index = 0; index < await results.count(); index += 1) {
    const locator = results.nth(index);
    if (!await locator.isVisible().catch(() => false)) continue;
    visibleResults.push({ locator, name: (await locator.innerText()).trim() });
  }
  const selected = chooseAccountMatch(visibleResults.map((result) => result.name), credentials.account);
  const result = visibleResults[selected.index].locator;
  await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), result.click()]);
  await page.locator("#changeSuccess, #accountName").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  await context.log({ level: "info", message: `Waystar account selected: ${selected.name}.`, eventName: "waystar_payment_account_selected" });
}

async function navigateToPayments(page: Page, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Claims Processing menu.", eventName: "waystar_payment_claims_menu" });
  const claims = page.locator(".header-menu > a, a").filter({ hasText: /^\s*Claims Processing\s*$/i }).first();
  await claims.waitFor({ state: "visible", timeout: 30000 });
  await claims.hover();
  const claimsMenu = claims.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' header-menu ')][1]");
  const flyout = claimsMenu.locator(".header-flyout").first();
  await flyout.waitFor({ state: "visible", timeout: 10000 });
  const remits = flyout.locator("a").filter({ hasText: /^\s*Remits\s*$/i }).first();
  await remits.waitFor({ state: "visible", timeout: 10000 });
  await remits.click();
  await context.log({ level: "info", message: "Claims Processing > Remits selected; waiting for the Remits submenu.", eventName: "waystar_payment_remits_menu" });

  const payments = page.locator('.header-flyout:visible a[href*="/Payments" i]').filter({ hasText: /^\s*Payments\s*$/i }).first();
  const paymentsVisible = await payments.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
  if (paymentsVisible) {
    await context.log({ level: "info", message: "Remits submenu opened; selecting Payments.", eventName: "waystar_payment_payments_select" });
    await Promise.all([page.waitForURL(/\/Payments(?:\?|$)/i, { timeout: 60000 }), payments.click()]);
  } else {
    await context.log({ level: "warn", message: "Payments submenu link remained hidden after selecting Remits; opening the Waystar Payments URL directly.", eventName: "waystar_payment_payments_fallback" });
    await page.goto("https://remits.zirmed.com/Payments?appid=13", { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  await page.locator("#ulSearchOptions").waitFor({ state: "visible", timeout: 30000 });
  await context.log({ level: "info", message: "Waystar Payments page loaded.", eventName: "waystar_payment_page_loaded" });
}

async function searchPayment(page: Page, checkNumber: string, context: AutomationContext, rowNumber: number): Promise<WaystarPaymentRecord[]> {
  const viewOptions = page.locator("#SearchOptions_ViewOptions").first();
  await viewOptions.waitFor({ state: "visible", timeout: 30000 });
  await viewOptions.selectOption({ label: "All" }).catch(async () => {
    await viewOptions.selectOption("0");
  });
  const payment = page.locator("#SearchOptions_PaymentNum").first();
  await payment.waitFor({ state: "visible", timeout: 30000 });
  await payment.scrollIntoViewIfNeeded();
  await payment.click();
  await payment.press("Control+A").catch(() => {});
  await payment.press("Backspace").catch(() => {});
  await payment.pressSequentially(checkNumber, { delay: 80 });
  await payment.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });
  const enteredPaymentNumber = await payment.inputValue();
  if (normalizePaymentNumber(enteredPaymentNumber) !== normalizePaymentNumber(checkNumber)) {
    throw new Error(`Waystar Payment # field did not retain check number ${checkNumber}; current value is "${enteredPaymentNumber}".`);
  }
  await page.locator("#SearchOptions_PayNumSearchType").selectOption("0");
  await context.log({ level: "info", message: `${checkNumber}: Payment # entered and Search Type set to Exact.`, eventName: "waystar_payment_filter_filled", rowIndex: rowNumber });
  const search = page.locator('#searchButton, #ulSearchOptions input[type="submit"][value="Search"], #btnSearch').first();
  await search.waitFor({ state: "visible", timeout: 30000 });
  await search.scrollIntoViewIfNeeded();
  await context.log({ level: "info", message: `${checkNumber}: clicking Search.`, eventName: "waystar_payment_search_click", rowIndex: rowNumber });
  await search.click();
  await page.locator("#filterContainer [data-controlid='SearchOptions_PaymentNum']")
    .filter({ hasText: checkNumber })
    .first()
    .waitFor({ state: "visible", timeout: 45000 });

  const progress = page.locator("#GridContentProgress").first();
  if (await progress.isVisible({ timeout: 1000 }).catch(() => false)) {
    await progress.waitFor({ state: "hidden", timeout: 45000 });
  }

  const settleDeadline = Date.now() + 15000;
  let emptyVisibleSince = 0;
  while (Date.now() < settleDeadline) {
    const candidateRows = page.locator("#paymentsTableGrid tr.gridViewRow[data-paymentnumber]");
    let foundExpected = false;
    for (let index = 0; index < await candidateRows.count(); index += 1) {
      const candidate = normalizePaymentNumber(await candidateRows.nth(index).getAttribute("data-paymentnumber"));
      if (candidate === normalizePaymentNumber(checkNumber)) {
        foundExpected = true;
        break;
      }
    }
    if (foundExpected) break;

    const emptyVisible = await page.locator("#paymentsTableGrid tr.gridViewEmpty").first().isVisible().catch(() => false);
    if (emptyVisible) {
      emptyVisibleSince ||= Date.now();
      if (Date.now() - emptyVisibleSince >= 2000) break;
    } else {
      emptyVisibleSince = 0;
    }
    await page.waitForTimeout(250);
  }

  const rows = page.locator("#paymentsTableGrid tr.gridViewRow[data-paymentnumber]");
  const records: WaystarPaymentRecord[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const paymentNumber = normalizePaymentNumber(await row.getAttribute("data-paymentnumber"));
    if (paymentNumber !== normalizePaymentNumber(checkNumber)) continue;
    records.push({
      paymentAmount: (await row.getAttribute("data-paymentamount"))?.trim() ?? "",
      paymentDate: (await row.getAttribute("data-paymentdate"))?.trim() ?? "",
      payer: (await row.getAttribute("data-payer"))?.trim() ?? "",
      type: (await row.getAttribute("data-type"))?.trim() ?? "",
      paymentNumber,
      rowIndex: index,
    });
  }
  await context.log({ level: "info", message: `${checkNumber}: search completed with ${records.length} exact Payment # result(s).`, eventName: "waystar_payment_search_results", rowIndex: rowNumber });
  return records;
}

async function revealViewEob(page: Page, row: Locator): Promise<Locator> {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.click().catch(() => {});
  const action = page.locator("#paymentsTableGrid .gridActionMenu a, .gridActionMenu .innerGridActionDiv a").filter({ hasText: /^View EOB$/ }).first();
  if (await action.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) return action;

  const checkbox = row.locator("input.selectedRow, input[type='checkbox']").first();
  if (await checkbox.isVisible().catch(() => false)) await checkbox.check().catch(() => {});
  const viewMenu = page.getByRole("button", { name: /^View(?:\s|$)/i }).first()
    .or(page.locator("input[value='View'], a, button").filter({ hasText: /^\s*View\s*$/i }).first());
  await viewMenu.click();
  const menuAction = page.locator("a:visible, button:visible, [role='menuitem']:visible").filter({ hasText: /^\s*View EOB\s*$/i }).first();
  await menuAction.waitFor({ state: "visible", timeout: 10000 });
  return menuAction;
}

async function clickViewerDownload(page: Page): Promise<Download | null> {
  const downloadPromise = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);
  const selectors = [
    "viewer-download-controls #save",
    "cr-icon-button#download",
    "cr-icon-button[aria-label='Download']",
    "cr-icon-button[title='Download']",
    "button[aria-label='Download']",
    "button[title='Download']",
    "[role='button'][aria-label='Download']",
  ];

  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const button = frame.locator(selector).first();
      if (!(await button.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await button.click({ force: true }).catch(async () => {
        await button.evaluate((element) => (element as HTMLElement).click());
      });
      return downloadPromise;
    }
  }
  return null;
}

async function readPdfFromVisibleViewer(page: Page): Promise<Buffer | null> {
  const pdfResponse = await page.waitForResponse((response) =>
    /application\/pdf/i.test(response.headers()["content-type"] ?? "") || /ViewEOB|\.pdf(?:[?#]|$)/i.test(response.url()),
  { timeout: 5000 }).catch(() => null);
  if (pdfResponse?.ok()) {
    const body = await pdfResponse.body().catch(() => null);
    if (body?.subarray(0, 5).equals(Buffer.from("%PDF-"))) return body;
  }

  const candidates = new Set<string>();
  for (const frame of page.frames()) {
    if (/ViewEOB|\.pdf(?:[?#]|$)/i.test(frame.url())) candidates.add(frame.url());
    const urls = await frame.locator("iframe[src], embed[src], object[data]").evaluateAll((elements) => elements.map((element) => {
      const raw = element.getAttribute("src") || element.getAttribute("data") || "";
      try { return raw ? new URL(raw, document.baseURI).toString() : ""; } catch { return ""; }
    })).catch(() => [] as string[]);
    urls.filter(Boolean).forEach((url) => candidates.add(url));
  }

  for (const url of candidates) {
    if (!url || url.startsWith("blob:") || !/ViewEOB|\.pdf(?:[?#]|$)/i.test(url)) continue;
    const response = await page.request.get(url, { headers: { accept: "application/pdf,*/*", referer: page.url() } }).catch(() => null);
    if (!response?.ok()) continue;
    const body = await response.body();
    if (body.subarray(0, 5).equals(Buffer.from("%PDF-"))) return body;
  }
  return null;
}

async function closeEobViewer(page: Page): Promise<void> {
  const close = page.locator(".ui-dialog:visible .ui-dialog-titlebar-close, a.ui-dialog-titlebar-close:visible, button[aria-label='Close']:visible").first();
  if (await close.isVisible({ timeout: 2000 }).catch(() => false)) {
    await close.click({ force: true }).catch(async () => {
      await close.evaluate((element) => (element as HTMLElement).click()).catch(() => {});
    });
  }
  await page.locator(".ui-dialog:visible").first().waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
}

async function findPaymentRow(page: Page, paymentNumber: string): Promise<Locator | null> {
  const rows = page.locator("#paymentsTableGrid tr.gridViewRow[data-paymentnumber]");
  for (let index = 0; index < await rows.count(); index += 1) {
    if (normalizePaymentNumber(await rows.nth(index).getAttribute("data-paymentnumber")) === normalizePaymentNumber(paymentNumber)) {
      return rows.nth(index);
    }
  }
  return null;
}

async function activatePaymentRow(page: Page, row: Locator): Promise<Locator> {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.click().catch(() => {});
  const menu = page.locator("#paymentsTableGrid .gridActionMenu:visible .innerGridActionDiv, .gridActionMenu:visible .innerGridActionDiv").first();
  await menu.waitFor({ state: "visible", timeout: 10000 });
  return menu;
}

async function archiveDownloadedPayment(page: Page, record: WaystarPaymentRecord, context: AutomationContext, rowNumber: number): Promise<"ARCHIVED_SUCCESS" | "ALREADY_ARCHIVED"> {
  const row = await findPaymentRow(page, record.paymentNumber);
  if (!row) throw new Error(`Downloaded payment ${record.paymentNumber} could not be found again for archiving.`);
  const menu = await activatePaymentRow(page, row);
  const unarchive = menu.locator("a").filter({ hasText: /^\s*Unarchive\s*$/i }).first();
  if (await unarchive.isVisible({ timeout: 1000 }).catch(() => false)) {
    await context.log({ level: "info", message: `${record.paymentNumber}: already archived; Unarchive is displayed, so no archive action was taken.`, eventName: "waystar_payment_already_archived", rowIndex: rowNumber });
    return "ALREADY_ARCHIVED";
  }

  const archive = menu.locator("a").filter({ hasText: /^\s*Archive\s*$/i }).first();
  await archive.waitFor({ state: "visible", timeout: 10000 });
  await context.log({ level: "info", message: `${record.paymentNumber}: selecting Archive after EOB download.`, eventName: "waystar_payment_archive_start", rowIndex: rowNumber });
  await archive.click();

  const confirmation = page.locator(".ui-dialog:visible").first();
  if (await confirmation.isVisible({ timeout: 1500 }).catch(() => false)) {
    const confirm = confirmation.locator("button, input[type='button'], input[type='submit']")
      .filter({ hasText: /^\s*(?:Archive|OK|Yes)\s*$/i })
      .or(confirmation.locator("input[value='Archive'], input[value='OK'], input[value='Yes']"))
      .first();
    if (await confirm.isVisible({ timeout: 1000 }).catch(() => false)) await confirm.click();
  }

  const progress = page.locator("#GridContentProgress").first();
  if (await progress.isVisible({ timeout: 1000 }).catch(() => false)) {
    await progress.waitFor({ state: "hidden", timeout: 30000 });
  }

  const refreshedRow = await findPaymentRow(page, record.paymentNumber);
  if (!refreshedRow) throw new Error(`${record.paymentNumber}: payment row disappeared after Archive was clicked.`);
  const refreshedMenu = await activatePaymentRow(page, refreshedRow);
  await refreshedMenu.locator("a").filter({ hasText: /^\s*Unarchive\s*$/i }).first().waitFor({ state: "visible", timeout: 15000 });
  await context.log({ level: "info", message: `${record.paymentNumber}: archived successfully; the row now shows Unarchive.`, eventName: "waystar_payment_archive_complete", rowIndex: rowNumber });
  return "ARCHIVED_SUCCESS";
}

function formatWaystarFilterDate(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
}

async function setLegacyFilterInput(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 30000 });
  await input.click();
  await input.press("Control+A").catch(() => {});
  await input.press("Backspace").catch(() => {});
  if (value) await input.pressSequentially(value, { delay: 60 });
  await input.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });
}

async function setWaystarDateFilterInput(page: Page, selector: string, value: string): Promise<void> {
  const input = page.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 30000 });

  // These fields use a legacy jQuery datepicker. Updating both the input and
  // datepicker state avoids the value being cleared when the calendar closes.
  await input.evaluate((element, dateValue) => {
    const dateInput = element as HTMLInputElement;
    const jquery = (window as typeof window & {
      jQuery?: (target: Element) => { datepicker?: (action: string, value?: string) => void };
    }).jQuery;

    if (jquery) {
      try {
        jquery(dateInput).datepicker?.("setDate", dateValue);
      } catch {
        dateInput.value = dateValue;
      }
    } else {
      dateInput.value = dateValue;
    }

    // Some Waystar pages do not have the datepicker plugin attached yet.
    if (dateInput.value !== dateValue) dateInput.value = dateValue;
    dateInput.dispatchEvent(new Event("input", { bubbles: true }));
    dateInput.dispatchEvent(new Event("change", { bubbles: true }));
    dateInput.dispatchEvent(new Event("blur", { bubbles: true }));
  }, value);

  await page.keyboard.press("Escape").catch(() => {});
  const datepicker = page.locator("#ui-datepicker-div").first();
  if (await datepicker.isVisible({ timeout: 500 }).catch(() => false)) {
    await datepicker.evaluate((element) => {
      (element as HTMLElement).style.display = "none";
    });
  }
  await datepicker.waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});

  const retainedValue = (await input.inputValue()).trim();
  if (retainedValue !== value) {
    throw new Error(`Waystar date field ${selector} did not retain ${value}; current value is ${retainedValue || "empty"}.`);
  }
}

async function waitForWaystarGridProgress(page: Page): Promise<void> {
  const progress = page.locator("#GridContentProgress").first();
  if (await progress.isVisible({ timeout: 1000 }).catch(() => false)) {
    await progress.waitFor({ state: "hidden", timeout: 45000 });
  }
  await page.waitForTimeout(500);
}

async function readAllVisiblePaymentRecords(page: Page): Promise<WaystarPaymentRecord[]> {
  const rows = page.locator("#paymentsTableGrid tr.gridViewRow[data-paymentnumber]");
  const records: WaystarPaymentRecord[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    records.push({
      paymentAmount: (await row.getAttribute("data-paymentamount"))?.trim() ?? "",
      paymentDate: (await row.getAttribute("data-paymentdate"))?.trim() ?? "",
      payer: (await row.getAttribute("data-payer"))?.trim() ?? "",
      type: (await row.getAttribute("data-type"))?.trim() ?? "",
      paymentNumber: normalizePaymentNumber(await row.getAttribute("data-paymentnumber")),
      rowIndex: index,
    });
  }
  return records;
}

async function readRowArchiveAction(page: Page, paymentNumber: string): Promise<"Archive" | "Unarchive"> {
  const row = await findPaymentRow(page, paymentNumber);
  if (!row) throw new Error(`${paymentNumber}: zero-payment row could not be found.`);
  const menu = await activatePaymentRow(page, row);
  if (await menu.locator("a").filter({ hasText: /^\s*Unarchive\s*$/i }).first().isVisible({ timeout: 1000 }).catch(() => false)) return "Unarchive";
  if (await menu.locator("a").filter({ hasText: /^\s*Archive\s*$/i }).first().isVisible({ timeout: 1000 }).catch(() => false)) return "Archive";
  throw new Error(`${paymentNumber}: neither Archive nor Unarchive was available.`);
}

async function runZeroPaymentsPhase(
  page: Page,
  credentials: WaystarPaymentCredentials,
  outputFolder: string,
  context: AutomationContext,
): Promise<WaystarZeroPaymentOutputRow[]> {
  const toDate = new Date();
  const fromDate = new Date(toDate);
  fromDate.setDate(fromDate.getDate() - credentials.lookbackDays);
  const fromText = formatWaystarFilterDate(fromDate);
  const toText = formatWaystarFilterDate(toDate);

  await context.log({ level: "info", message: `Starting Phase 2: zero payments from ${fromText} through ${toText} (${credentials.lookbackDays} lookback days).`, eventName: "waystar_zero_payments_start" });
  await setLegacyFilterInput(page, "#SearchOptions_PaymentNum", "");
  await page.locator("#SearchOptions_PayNumSearchType").selectOption("0");
  await setLegacyFilterInput(page, "#SearchOptions_Amount", "0");
  await page.locator("#SearchOptions_Type").selectOption("0");
  await page.locator("#SearchOptions_ReceivedDate").selectOption("5");
  await setWaystarDateFilterInput(page, "#SearchOptions_ReceivedDateFrom", fromText);
  await setWaystarDateFilterInput(page, "#SearchOptions_ReceivedDateTo", toText);
  await page.locator("#SearchOptions_ViewOptions").selectOption("0");
  const includeZero = page.locator("#SearchOptions_IncludeZeroPayment").first();
  if (await includeZero.isVisible().catch(() => false)) await includeZero.check().catch(() => {});

  const search = page.locator("#searchButton").first();
  await page.locator("#ui-datepicker-div").first().waitFor({ state: "hidden", timeout: 5000 }).catch(() => {});
  await search.scrollIntoViewIfNeeded();
  await search.click();
  await page.locator("#filterContainer [data-controlid='SearchOptions_Amount']").filter({ hasText: /Amount:\s*0/i }).first().waitFor({ state: "visible", timeout: 45000 });
  await waitForWaystarGridProgress(page);
  await context.log({ level: "info", message: "Phase 2 zero-payment filters applied: Amount=0, View Options=All, and custom Received Date range.", eventName: "waystar_zero_payments_filtered" });

  const perPage = page.locator("#paymentsTableGrid #PagerDiv .pageSize select").first();
  if (await perPage.isVisible({ timeout: 5000 }).catch(() => false)) {
    const values = await perPage.locator("option").evaluateAll((options) => options.map((option) => Number((option as HTMLOptionElement).value)).filter(Number.isFinite));
    const highest = Math.max(...values);
    if (Number.isFinite(highest)) {
      await perPage.selectOption(String(highest));
      await waitForWaystarGridProgress(page);
      await page.waitForFunction((expected) => {
        const select = document.querySelector<HTMLSelectElement>("#paymentsTableGrid #PagerDiv .pageSize select");
        const progress = document.querySelector<HTMLElement>("#GridContentProgress");
        const progressVisible = Boolean(progress && window.getComputedStyle(progress).display !== "none");
        if (!select || select.value !== expected || progressVisible) return false;
        const total = Number(document.querySelector("#paymentsTableGrid .total-records")?.textContent?.trim() || "0");
        const visibleRows = document.querySelectorAll("#paymentsTableGrid tr.gridViewRow[data-paymentnumber]").length;
        return visibleRows >= Math.min(total, Number(expected));
      }, String(highest), { timeout: 45000 }).catch(() => {});
      await context.log({ level: "info", message: `Phase 2 Per Page set to the highest available value: ${highest}.`, eventName: "waystar_zero_payments_page_size" });
    }
  }

  const records = (await readAllVisiblePaymentRecords(page)).filter((record) => normalizeAmount(record.paymentAmount) === 0);
  await context.log({ level: "info", message: `Phase 2 found ${records.length} visible zero-payment row(s).`, eventName: "waystar_zero_payments_results" });
  const outputRows: WaystarZeroPaymentOutputRow[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const outputRow: WaystarZeroPaymentOutputRow = {
      source: "Waystar",
      modeOfPayment: record.type,
      checkNumber: record.paymentNumber,
      depositDatePaymentPostingDate: record.paymentDate,
      batchTotalAmount: record.paymentAmount,
      pdfFileName: "",
      downloadStatus: "DOWNLOAD_FAILED",
      archiveStatus: "NOT_ATTEMPTED",
      error: "",
    };
    try {
      const archiveAction = await readRowArchiveAction(page, record.paymentNumber);
      if (archiveAction === "Unarchive") {
        await context.log({ level: "info", message: `${record.paymentNumber}: zero payment is already archived; skipped.`, eventName: "waystar_zero_payment_already_archived" });
        continue;
      }

      await context.log({ level: "info", message: `${record.paymentNumber}: new zero payment (${index + 1} of ${records.length}); downloading View EOB.`, eventName: "waystar_zero_payment_download_start" });
      const filename = await downloadEob(page, record, outputFolder);
      outputRow.pdfFileName = filename;
      outputRow.downloadStatus = "DOWNLOAD_SUCCESS";
      await context.log({ level: "info", message: `${record.paymentNumber}: zero-payment EOB downloaded as ${filename}.`, eventName: "waystar_zero_payment_download_complete" });
      try {
        outputRow.archiveStatus = await archiveDownloadedPayment(page, record, context, 0) === "ARCHIVED_SUCCESS"
          ? "ARCHIVED_SUCCESS"
          : "ARCHIVE_FAILED";
      } catch (archiveError) {
        outputRow.archiveStatus = "ARCHIVE_FAILED";
        outputRow.error = `EOB downloaded, but Archive failed: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`;
        await context.log({ level: "error", message: `${record.paymentNumber}: ${outputRow.error}`, eventName: "waystar_zero_payment_archive_failed" });
      }
    } catch (error) {
      outputRow.error = error instanceof Error ? error.message : String(error);
      await context.log({ level: "error", message: `${record.paymentNumber}: zero-payment processing failed: ${outputRow.error}`, eventName: "waystar_zero_payment_failed" });
    }
    outputRows.push(outputRow);
  }

  const downloadedCount = outputRows.filter((row) => row.downloadStatus === "DOWNLOAD_SUCCESS").length;
  await context.log({ level: "info", message: `Phase 2 completed with ${downloadedCount} newly downloaded zero-payment EOB(s).`, eventName: "waystar_zero_payments_complete" });
  return outputRows;
}

async function downloadEob(page: Page, record: WaystarPaymentRecord, folder: string): Promise<string> {
  const row = page.locator("#paymentsTableGrid tr.gridViewRow[data-paymentnumber]").nth(record.rowIndex);
  const action = await revealViewEob(page, row);
  const existingPages = new Set(page.context().pages());
  const immediateDownloadPromise = page.waitForEvent("download", { timeout: 10000 }).catch(() => null);
  const popupPromise = page.context().waitForEvent("page", { timeout: 10000 }).catch(() => null);
  const modal = page.locator(".ui-dialog:visible").filter({ hasText: /View EOB/i }).first();
  await action.click();
  const filename = `${safePart(record.paymentNumber)}_${safePart(record.paymentDate)}.pdf`;
  const outputPath = path.join(folder, filename);
  const modalOpened = await modal.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
  const immediateDownload = await immediateDownloadPromise;
  const popup = (await popupPromise) ?? page.context().pages().find((candidate) => !existingPages.has(candidate)) ?? null;

  if (immediateDownload) {
    await immediateDownload.saveAs(outputPath);
  } else if (modalOpened) {
    const viewerDownload = await clickViewerDownload(page);
    if (viewerDownload) {
      await viewerDownload.saveAs(outputPath);
    } else {
      const pdf = await readPdfFromVisibleViewer(page);
      if (!pdf) throw new Error("Waystar View EOB opened, but its Download control and PDF content could not be accessed.");
      await fs.writeFile(outputPath, pdf);
    }
    await closeEobViewer(page);
  } else if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    const viewerDownload = await clickViewerDownload(popup);
    if (viewerDownload) {
      await viewerDownload.saveAs(outputPath);
    } else {
      const pdf = await readPdfFromVisibleViewer(popup);
      if (!pdf) throw new Error("Waystar EOB popup opened, but its Download control and PDF content could not be accessed.");
      await fs.writeFile(outputPath, pdf);
    }
    await popup.close().catch(() => {});
  } else {
    throw new Error("Waystar View EOB did not open a modal, popup, or PDF download.");
  }

  return filename;
}

function baseResult(row: WaystarControlLogRow): WaystarSearchResult {
  return { phase: "Cash Log", clientName: row.clientName, inputCheckNumber: row.checkNumber, inputBatchTotalAmount: row.batchTotalAmount,
    searchResult: "NOT_FOUND", portalPaymentNumber: "", portalPaymentAmount: "", portalPaymentDate: "", portalPayer: "", portalType: "",
    amountMatch: "", pdfStatus: "NOT_DOWNLOADED", pdfFileName: "", archiveStatus: "NOT_ATTEMPTED", finalResult: "NOT_FOUND", error: "" };
}

function zeroPaymentSearchResult(row: WaystarZeroPaymentOutputRow): WaystarSearchResult {
  const archiveFailed = row.archiveStatus === "ARCHIVE_FAILED";
  const downloadSucceeded = row.downloadStatus === "DOWNLOAD_SUCCESS";
  return {
    phase: "Zero Payments",
    clientName: "",
    inputCheckNumber: "",
    inputBatchTotalAmount: "",
    searchResult: "FOUND",
    portalPaymentNumber: row.checkNumber,
    portalPaymentAmount: row.batchTotalAmount,
    portalPaymentDate: row.depositDatePaymentPostingDate,
    portalPayer: "",
    portalType: row.modeOfPayment,
    amountMatch: "",
    pdfStatus: row.downloadStatus,
    pdfFileName: row.pdfFileName,
    archiveStatus: row.archiveStatus,
    finalResult: archiveFailed ? "ERROR" : downloadSucceeded ? "DOWNLOAD_SUCCESS" : "DOWNLOAD_FAILED",
    error: row.error,
  };
}

async function runJob(credentials: WaystarPaymentCredentials, allRows: WaystarControlLogRow[], context: AutomationContext): Promise<void> {
  const eligible = allRows.filter(isEligibleWaystarControlRow);
  const rootName = `WaystarPaymentEobDownloads_${datePart()}_${context.jobId}`;
  const root = path.join(getJobDataPath(context.jobId, "outputs"), rootName);
  const pdfFolder = path.join(root, "PDFs");
  const zeroPaymentPdfFolder = path.join(root, "Zero Payment PDFs");
  await fs.mkdir(pdfFolder, { recursive: true });
  await fs.mkdir(zeroPaymentPdfFolder, { recursive: true });
  const results: WaystarSearchResult[] = [];
  let zeroPaymentRows: WaystarZeroPaymentOutputRow[] = [];
  let browser: Awaited<ReturnType<typeof launchAutomationBrowser>> | null = null;
  await context.emit({ type: "progress", completed: 0, total: eligible.length });
  try {
    browser = await launchAutomationBrowser();
    const page = browser.context.pages()[0] ?? await browser.context.newPage();
    page.setDefaultTimeout(30000);
    await context.log({ level: "info", message: "Opening Waystar and signing in.", eventName: "waystar_payment_login_start" });
    await loginToWaystarClaimStatus(page, credentials);
    await context.log({ level: "info", message: "Waystar authentication completed, including any security verification.", eventName: "waystar_payment_login_complete" });
    await selectAccount(page, credentials, context);
    await navigateToPayments(page, context);
    for (let index = 0; index < eligible.length; index += 1) {
      const input = eligible[index];
      const result = baseResult(input);
      if (!isUsableCheckNumber(input.checkNumber)) {
        result.searchResult = "ERROR";
        result.finalResult = "ERROR";
        result.archiveStatus = "NOT_APPLICABLE";
        result.error = "No Check number";
        results.push(result);
        await context.log({ level: "warn", message: "No Check number", eventName: "waystar_payment_no_check_number", rowIndex: input.rowNumber });
        await context.emit({ type: "progress", completed: index + 1, total: eligible.length });
        continue;
      }
      try {
        await context.log({ level: "info", message: `Searching Waystar for payment ${input.checkNumber} (${index + 1} of ${eligible.length}).`, eventName: "waystar_payment_search_start", rowIndex: input.rowNumber });
        const matches = await searchPayment(page, input.checkNumber, context, input.rowNumber);
        const exact = matches.find((entry) => normalizeAmount(entry.paymentAmount) === normalizeAmount(input.batchTotalAmount));
        const portal = exact ?? matches[0];
        if (portal) Object.assign(result, { searchResult: "FOUND", portalPaymentNumber: portal.paymentNumber, portalPaymentAmount: portal.paymentAmount,
          portalPaymentDate: portal.paymentDate, portalPayer: portal.payer, portalType: portal.type, amountMatch: exact ? "YES" : "NO" });
        if (!portal) {
          result.error = "No Waystar payment matched the input check number.";
          await context.log({ level: "warn", message: `No Waystar payment found for ${input.checkNumber}.`, eventName: "waystar_payment_not_found", rowIndex: input.rowNumber });
        } else if (!exact) {
          result.searchResult = "AMOUNT_MISMATCH"; result.finalResult = "AMOUNT_MISMATCH";
          result.error = "Payment amount not matched";
          await context.log({ level: "warn", message: `${input.checkNumber}: Payment amount not matched. Portal amount ${portal.paymentAmount}; input amount ${input.batchTotalAmount}.`, eventName: "waystar_payment_amount_mismatch", rowIndex: input.rowNumber });
        } else {
          try {
            await context.log({ level: "info", message: `${input.checkNumber}: payment and amount matched; downloading View EOB.`, eventName: "waystar_payment_download_start", rowIndex: input.rowNumber });
            result.pdfFileName = await downloadEob(page, exact, pdfFolder);
            result.pdfStatus = "DOWNLOAD_SUCCESS"; result.finalResult = "DOWNLOAD_SUCCESS";
            await context.log({ level: "info", message: `${input.checkNumber}: downloaded ${result.pdfFileName}.`, eventName: "waystar_payment_download_complete", rowIndex: input.rowNumber });
            try {
              result.archiveStatus = await archiveDownloadedPayment(page, exact, context, input.rowNumber);
            } catch (archiveError) {
              result.archiveStatus = "ARCHIVE_FAILED";
              result.finalResult = "ERROR";
              result.error = `EOB downloaded, but Archive failed: ${archiveError instanceof Error ? archiveError.message : String(archiveError)}`;
              await context.log({ level: "error", message: `${input.checkNumber}: ${result.error}`, eventName: "waystar_payment_archive_failed", rowIndex: input.rowNumber });
            }
          } catch (error) {
            result.pdfStatus = "DOWNLOAD_FAILED"; result.finalResult = "DOWNLOAD_FAILED";
            result.error = error instanceof Error ? error.message : String(error);
          }
        }
      } catch (error) {
        result.searchResult = "ERROR"; result.finalResult = "ERROR";
        result.error = error instanceof Error ? error.message : String(error);
      }
      results.push(result);
      await context.log({ level: result.finalResult === "DOWNLOAD_SUCCESS" ? "info" : "warn", message: `${input.checkNumber}: ${result.finalResult}.`, eventName: "waystar_payment_eob_row_complete", rowIndex: input.rowNumber });
      await context.emit({ type: "progress", completed: index + 1, total: eligible.length });
    }
    try {
      zeroPaymentRows = await runZeroPaymentsPhase(page, credentials, zeroPaymentPdfFolder, context);
      results.push(...zeroPaymentRows.map(zeroPaymentSearchResult));
    } catch (error) {
      await context.log({ level: "error", message: `Phase 2 zero-payment workflow failed: ${error instanceof Error ? error.message : String(error)}`, eventName: "waystar_zero_payments_failed" });
    }
  } finally {
    await browser?.browser?.close().catch(() => {});
  }

  const searchName = `Waystar_Search_Results_${datePart()}.xlsx`;
  const zeroPaymentsName = `Zero Payments_${datePart()}.xlsx`;
  await fs.writeFile(path.join(root, searchName), await buildWaystarSearchResults(results));
  await fs.writeFile(path.join(root, zeroPaymentsName), await buildWaystarZeroPayments(zeroPaymentRows));
  await context.log({ level: "info", message: "Waystar Search Results and Zero Payments output workbooks created.", eventName: "waystar_payment_outputs_created" });
  const zip = await createStoredZipFromFolder(root, rootName);
  await context.emit({ type: "file_download", filename: `${rootName}.zip`, base64: zip.toString("base64"), mimeType: "application/zip" });
  await context.log({ level: "info", message: `Waystar output package ready: ${rootName}.zip.`, eventName: "waystar_payment_package_ready" });
}

export function createWaystarPaymentEobRunner(): AutomationRunner<PaymentEobRunInput> {
  return { workflowId: "payment-eob-download", portalId: waystarPaymentEobConfig.id, name: waystarPaymentEobConfig.name,
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("Payment EOB input must be multipart form data.");
      return { credentialExcel: requireFile(input, "credentialExcel", "Credential Excel"), referenceExcel: requireFile(input, "referenceExcel", "Control Log Excel") };
    },
    async run(input, context) {
      await context.log({ level: "info", message: "Reading Waystar credential workbook and Control Log.", eventName: "waystar_payment_input_start" });
      const credentials = await readWaystarPaymentCredentials(input.credentialExcel);
      const control = await readWaystarControlLog(input.referenceExcel!);
      const eligibleCount = control.rows.filter(isEligibleWaystarControlRow).length;
      await context.log({ level: "info", message: `Input validation completed. ${eligibleCount} row(s) with Source=Waystar and Entry Status=In-Process will be processed.`, eventName: "waystar_payment_input_complete" });
      await runJob(credentials, control.rows, context);
    } };
}
