import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import type { Frame, Locator, Page } from "playwright-core";
import type { AutomationContext } from "../../../types";
import { launchAvailityBrowser } from "@/backend/src/workflows/claim-status/portals/availity/browser";
import { getJobDataPath } from "@/backend/src/core/storage";
import type {
  PaymentEobComparisonRow,
  PaymentEobCredentials,
  PaymentEobPortalRecord,
  PaymentEobReferenceRow,
  PaymentTrackerRow,
} from "../../types";
import { normalizeCheckNumber, normalizeCheckNumberForComparison } from "./input";
import { createPaymentEobResultWorkbookBuffer, createPaymentTrackerWorkbookBuffer } from "./output-builder";
import { uploadPaymentEobOutputToSharePoint } from "./sharepoint";
import { addPaymentTrackerRow } from "./tracker";
import { createStoredZipFromFolder } from "./zip";
import { isMedRevenuePendingEftRow, resolveAvailityRemittanceProcess } from "./process-registry";

const require = createRequire(import.meta.url);
const { submitLogin } = require("../../../claim-status/portals/availity/pages/login.page.js");
const { handleMfa } = require("../../../claim-status/portals/availity/pages/mfa.page.js");
const { acceptCookiesIfPresent, logoutIfPresent } = require("../../../claim-status/portals/availity/pages/navigation.page.js");

type RunInput = {
  credentials: PaymentEobCredentials;
  referenceRows: PaymentEobReferenceRow[];
};

type RemittanceSurface = Page | Frame;

function todayMmDdYyyy(): string {
  const date = new Date();
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
}

function todayYyyyMmDd(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function daysAgoMmDdYyyy(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`;
}

export function parseRemittanceCsv(text: string): PaymentEobPortalRecord[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);

  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  return rows
    .map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])))
    .map(portalRecordFromCsv)
    .filter((record): record is PaymentEobPortalRecord => Boolean(record));
}

function findValue(row: Record<string, string>, aliases: string[]): string {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]+/g, ""), value]));
  for (const alias of aliases) {
    const value = normalized.get(alias.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    if (value) return value.trim();
  }
  return "";
}

function portalRecordFromCsv(row: Record<string, string>): PaymentEobPortalRecord | null {
  const checkNumber = findValue(row, ["Check/EFT #", "Check/EFT Number", "Check EFT Number", "Check Number", "EFT Number"]);
  if (!checkNumber) return null;
  return {
    checkNumber,
    checkDate: findValue(row, ["Check/EFT Date", "Check / EFT Date", "Check Date", "Payment Date"]),
    payer: findValue(row, ["Payer"]),
    payee: findValue(row, ["Payee"]),
    receivedByAvaility: findValue(row, ["Received by Availity", "Received Date"]),
    amount: findValue(row, ["Check/EFT Amount", "Amount"]),
    raw: row,
  };
}

function safeFilePart(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_");
}

function dateFilePart(value: string): string {
  const match = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return safeFilePart(value);
  return `${match[3]}-${match[1].padStart(2, "0")}-${match[2].padStart(2, "0")}`;
}

async function fillDate(locator: Locator, date: string): Promise<void> {
  await locator.click();
  await locator.press("Control+A");
  await locator.fill(date);
  await locator.press("Tab");
  if ((await locator.inputValue().catch(() => "")) !== date) {
    await locator.click();
    await locator.press("Control+A");
    await locator.fill(date);
    await locator.press("Tab");
  }
}

async function clearInput(locator: Locator): Promise<void> {
  await locator.click();
  await locator.press("Control+A");
  await locator.press("Backspace");
  await locator.press("Tab");
  if (await locator.inputValue().catch(() => "")) {
    await locator.click();
    await locator.press("Control+A");
    await locator.press("Backspace");
    await locator.press("Tab");
  }
}

/**
 * Saves a screenshot + full HTML snapshot of the current page to
 * <outputRoot>/diagnostics/. Called whenever a step on the Remittance Viewer
 * filter/results page fails, so the next run's output folder shows exactly
 * what the browser was looking at instead of just a bare timeout message.
 */
async function captureDiagnostics(page: Page, outputRoot: string, label: string): Promise<void> {
  try {
    const dir = path.join(outputRoot, "diagnostics");
    await fs.mkdir(dir, { recursive: true });
    const safeLabel = safeFilePart(label).slice(0, 80);
    const stamp = Date.now();
    await page.screenshot({ path: path.join(dir, `${stamp}_${safeLabel}.png`), fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    if (html) await fs.writeFile(path.join(dir, `${stamp}_${safeLabel}.html`), html, "utf8").catch(() => {});
  } catch {
    // Diagnostics capture must never itself break the job.
  }
}

async function login(page: Page, credentials: PaymentEobCredentials, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Availity login page.", eventName: "payment_eob_availity_login_open" });
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await submitLogin(page, credentials.username, credentials.password);
  await handleMfa(page, credentials.totpSecret, 2, 0, 20);
  await acceptCookiesIfPresent(page, 10000);
  await context.log({ level: "info", message: "Availity login completed.", eventName: "payment_eob_availity_login_complete" });
}

function remittanceMarkers(surface: RemittanceSurface): Locator[] {
  return [
    surface.locator("#checkFilterButton"),
    surface.locator("#checkEFTorganizationId"),
    surface.locator("#checkSearchInput"),
    surface.locator('[role="table"][aria-label="Remits"]'),
  ];
}

function surfaceUrl(surface: RemittanceSurface): string {
  try {
    return surface.url();
  } catch {
    return "";
  }
}

async function findRemittanceViewerSurface(page: Page, timeoutMs = 60000): Promise<RemittanceSurface> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const surfaces: RemittanceSurface[] = [page, ...page.frames()];
    for (const surface of surfaces) {
      for (const marker of remittanceMarkers(surface)) {
        if (await marker.first().isVisible().catch(() => false)) return surface;
      }
    }
    await page.waitForTimeout(500);
  }

  const frameUrls = page.frames().map((frame) => frame.url()).filter(Boolean).join(" | ");
  throw new Error(`Remittance Viewer did not finish loading. Current URL: ${page.url()}. Frame URLs: ${frameUrls || "(none)"}`);
}

async function openRemittanceViewer(page: Page, context: AutomationContext, outputRoot: string): Promise<RemittanceSurface> {
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  const menuCandidates = [
    page.locator("button.NavDropdown__trigger[aria-label='Claims & Payments']"),
    page.getByRole("button", { name: "Claims & Payments", exact: true }),
    page.locator("button").filter({ hasText: /^Claims & Payments$/ }),
  ];
  try {
    await clickFirstVisible(menuCandidates, 60000);
  } catch (error) {
    await captureDiagnostics(page, outputRoot, "claims-payments-menu-not-found");
    throw new Error(`Unable to open Availity Claims & Payments menu. ${error instanceof Error ? error.message : String(error)}`);
  }

  const remittanceCandidates = [
    page.locator('[title="Remittance Viewer"]'),
    page.getByRole("link", { name: "Remittance Viewer", exact: true }),
    page.getByText("Remittance Viewer", { exact: true }),
  ];
  try {
    await clickFirstVisible(remittanceCandidates, 30000);
  } catch (error) {
    await captureDiagnostics(page, outputRoot, "remittance-viewer-link-not-found");
    throw new Error(`Unable to open Availity Remittance Viewer link. ${error instanceof Error ? error.message : String(error)}`);
  }
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  try {
    const surface = await findRemittanceViewerSurface(page);
    await context.log({
      level: "info",
      message: `Remittance Viewer controls detected at ${surface === page ? "top page" : `frame ${surfaceUrl(surface)}`}.`,
      eventName: "payment_eob_remittance_surface_detected",
    });
    return surface;
  } catch (error) {
    await captureDiagnostics(page, outputRoot, "remittance-viewer-not-ready");
    await context.log({
      level: "error",
      message: error instanceof Error ? error.message : String(error),
      eventName: "payment_eob_remittance_viewer_not_ready",
    });
    throw error;
  }
}

function normalizeOrgLabel(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

async function selectedOrganizationText(surface: RemittanceSurface): Promise<string> {
  return (await surface.locator("#checkEFTorganizationId .av__single-value").innerText().catch(() => "")).trim();
}

function organizationMatches(actual: string, expected: string | undefined): boolean {
  if (!expected || !expected.trim()) return true;
  const actualNorm = normalizeOrgLabel(actual);
  const expectedNorm = normalizeOrgLabel(expected);
  return actualNorm.includes(expectedNorm) || expectedNorm.includes(actualNorm);
}

async function organizationFilterValueMatches(surface: RemittanceSurface, organization: string | undefined): Promise<boolean> {
  const selectedOrg = await selectedOrganizationText(surface);
  return organizationMatches(selectedOrg, organization);
}

/**
 * The "Organization" field on the Remittance Viewer filter panel is NOT a native
 * <select>/<option> element — it's a react-select style combobox rendered as:
 *
 *   <div id="checkEFTorganizationId" class="av-select ...">
 *     <div class="av__control ...">
 *       <div class="av__single-value">All</div>
 *       <input id="organizationId" class="av__input" role="combobox" .../>
 *     </div>
 *   </div>
 *
 * with a floating menu (class "av__menu") containing "av__option" items once opened.
 * There is no <select> anywhere on the page, so locating one always times out.
 */
async function selectOrganizationIfProvided(
  surface: RemittanceSurface,
  page: Page,
  organization: string | undefined,
  context: AutomationContext,
  outputRoot: string,
): Promise<{ applied: boolean; selectedText: string }> {
  if (!organization || !organization.trim()) {
    await context.log({ level: "info", message: "No organization filter provided; leaving Organization = All.", eventName: "payment_eob_org_skip" });
    return { applied: false, selectedText: "All" };
  }
  const target = organization.trim();
  const normalizedTarget = normalizeOrgLabel(target);

  const container = surface.locator("#checkEFTorganizationId");
  await container.waitFor({ state: "visible", timeout: 30000 });

  const input = surface.locator("#organizationId");

  // React-select needs an explicit open before it will render .av__menu.
  // Clicking the dropdown arrow (or the control itself) opens the menu with
  // the full option list; only then do we type to filter it. Clicking the
  // input alone was sometimes not enough to trigger the menu to mount.
  await container.click();
  const menu = surface.locator(".av__menu");
  const menuOpenedOnClick = await menu.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false);
  if (!menuOpenedOnClick) {
    await context.log({ level: "warn", message: "Organization dropdown menu did not open on click; retrying via input focus.", eventName: "payment_eob_org_menu_retry" });
    await input.click();
  }

  await input.fill("");
  await input.pressSequentially(target, { delay: 40 });
  await menu.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});

  const options = menu.locator(".av__option");
  const optionCount = await options.count();
  const availableLabels = await options.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim() || ""));
  await context.log({
    level: "info",
    message: `Organization dropdown shows ${optionCount} option(s) after typing "${target}": ${availableLabels.join(", ") || "(none rendered)"}`,
    eventName: "payment_eob_org_options",
  });

  let matchedIndex = -1;
  // First pass: exact label match.
  for (let index = 0; index < optionCount; index += 1) {
    if (normalizeOrgLabel(availableLabels[index] ?? "") === normalizedTarget) {
      matchedIndex = index;
      break;
    }
  }
  // Second pass: fall back to a substring match if nothing matched exactly.
  if (matchedIndex === -1) {
    for (let index = 0; index < optionCount; index += 1) {
      const text = normalizeOrgLabel(availableLabels[index] ?? "");
      if (text.includes(normalizedTarget) || normalizedTarget.includes(text)) {
        matchedIndex = index;
        break;
      }
    }
  }

  if (matchedIndex === -1) {
    // Non-fatal: log clearly and back out to "All" rather than aborting the
    // entire job (and losing every other row) over one unmatched org label.
    await context.log({
      level: "warn",
      message: `Availity organization "${organization}" was not found in the dropdown (options: ${availableLabels.join(", ") || "none rendered"}). Continuing with Organization = All.`,
      eventName: "payment_eob_org_not_found",
    });
    await captureDiagnostics(page, outputRoot, "org-not-found");
    await page.keyboard.press("Escape").catch(() => {});
    await clearInput(input).catch(() => {});
    return { applied: false, selectedText: "All" };
  }

  await options.nth(matchedIndex).click();
  await menu.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});

  const selectedText = await selectedOrganizationText(surface);
  const stuck = organizationMatches(selectedText, target);
  if (!stuck) {
    await context.log({
      level: "warn",
      message: `Availity organization "${organization}" selection did not stick (control shows "${selectedText}"). Continuing anyway.`,
      eventName: "payment_eob_org_not_stuck",
    });
    await captureDiagnostics(page, outputRoot, "org-not-stuck");
  } else {
    await context.log({ level: "info", message: `Organization filter set to "${selectedText}".`, eventName: "payment_eob_org_selected" });
  }
  return { applied: stuck, selectedText };
}

async function waitForResultsRefresh(surface: RemittanceSurface): Promise<void> {
  // The results table is already visible from the default "last 7 days / All"
  // view, so waiting for it to become visible again is a no-op — it never
  // actually confirms the filtered data has loaded. Instead, wait for the
  // busy indicator to cycle and for the network to settle.
  const busyRegion = surface.locator('[aria-busy="true"]').first();
  await busyRegion.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
  await busyRegion.waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  await surface.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await surface.locator('[role="table"][aria-label="Remits"]').waitFor({ state: "visible", timeout: 30000 });
}

async function setZeroAmountFilter(surface: RemittanceSurface): Promise<void> {
  const candidates = [
    surface.locator("#checkAmount"),
    surface.locator("#checkcheckAmount"),
    surface.locator('input[name="checkAmount"]'),
    surface.locator('input[id*="amount" i]'),
    surface.getByLabel(/Check.*Amount|Amount/i),
  ];
  for (const candidate of candidates) {
    const input = candidate.first();
    if (await input.isVisible().catch(() => false)) {
      await input.fill("0");
      const enteredAmount = (await input.inputValue()).replace(/[$,\s]/g, "");
      if (Number(enteredAmount) !== 0) {
        throw new Error(`Availity Check / EFT Amount did not retain zero (current value: "${await input.inputValue()}").`);
      }
      return;
    }
  }
  throw new Error("MedRevenue zero-payments process could not find the Availity Amount filter.");
}

async function downloadPortalCsv(surface: RemittanceSurface, page: Page, context: AutomationContext, outputFolder: string, credentials: PaymentEobCredentials, options: { zeroAmount?: boolean } = {}): Promise<PaymentEobPortalRecord[]> {
  const startDate = credentials.startDate || daysAgoMmDdYyyy(credentials.lookbackDays);
  const endDate = credentials.endDate || todayMmDdYyyy();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await context.log({ level: "info", message: "Selecting Availity organization filter.", eventName: "payment_eob_org_select" });
    await selectOrganizationIfProvided(surface, page, credentials.organization, context, outputFolder);
    await surface.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const selectedOrg = await selectedOrganizationText(surface);
    await context.log({
      level: "info",
      message: `Organization filter verification after attempt ${attempt}/3: Organization="${selectedOrg || "(blank)"}".`,
      eventName: "payment_eob_filter_verify",
    });

    if (await organizationFilterValueMatches(surface, credentials.organization)) {
      break;
    }

    if (attempt === 3) {
      await captureDiagnostics(page, outputFolder, "filter-values-not-stable");
      throw new Error(`Unable to keep organization filter stable before clicking Filter. Expected Organization="${credentials.organization || "All"}". Current Organization="${selectedOrg || "(blank)"}".`);
    }
  }

  const filterButton = surface.locator("#checkFilterButton");
  if (options.zeroAmount) {
    try {
      await setZeroAmountFilter(surface);
    } catch (error) {
      await captureDiagnostics(page, outputFolder, "zero-amount-filter-not-found");
      throw error;
    }
    await context.log({ level: "info", message: "Amount filter set to 0 for MedRevenue zero payments.", eventName: "payment_eob_zero_amount_set" });
  }
  await context.log({ level: "info", message: "Clicking organization Filter.", eventName: "payment_eob_filter_click" });
  try {
    await filterButton.click();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/intercepts pointer events/i.test(message)) throw error;
    await context.log({ level: "warn", message: "An Availity overlay intercepted Filter; closing it and retrying once.", eventName: "payment_eob_filter_overlay_retry" });
    await page.keyboard.press("Escape");
    await filterButton.click();
  }
  await waitForResultsRefresh(surface);
  await context.log({ level: "info", message: "Organization-filtered results loaded.", eventName: "payment_eob_filter_loaded" });

  await context.log({
    level: "info",
    message: `Setting Check Dates search range ${startDate} - ${endDate}.`,
    eventName: "payment_eob_check_date_range",
  });
  await fillDate(surface.locator("#checkcheckDates-start"), startDate);
  await fillDate(surface.locator("#checkcheckDates-end"), endDate);
  await context.log({ level: "info", message: "Clicking Search for Check Dates.", eventName: "payment_eob_check_date_search" });
  await surface.locator("#checkSearchButton").click();
  await waitForResultsRefresh(surface);
  await context.log({ level: "info", message: "Check Date results loaded.", eventName: "payment_eob_check_date_loaded" });

  const csvDownloadPromise = page.waitForEvent("download");
  await surface.getByRole("button", { name: /Download CSV/i }).click();
  const csvDownload = await csvDownloadPromise;
  const csvPath = path.join(outputFolder, "portal_remittance_results.csv");
  await csvDownload.saveAs(csvPath);
  await context.log({ level: "info", message: `Downloaded portal remittance CSV to ${csvPath}.`, eventName: "payment_eob_csv_downloaded" });

  const csvText = await fs.readFile(csvPath, "utf8");
  await context.emit(downloadableFileEvent("portal_remittance_results.csv", Buffer.from(csvText, "utf8"), "text/csv"));
  const records = parseRemittanceCsv(csvText);
  if (!records.length) {
    await context.log({ level: "warn", message: "Portal CSV did not contain any Check/EFT records.", eventName: "payment_eob_csv_empty" });
  }
  return records;
}

async function selectCheckSuggestion(surface: RemittanceSurface, checkNumber: string): Promise<void> {
  const suggestion = surface.locator(".suggestion").filter({ hasText: `Check / EFT Number ${checkNumber}` }).first();
  if (await suggestion.isVisible().catch(() => false)) {
    await suggestion.click();
  }
}

async function clearSearchFilterChips(surface: RemittanceSurface, context?: AutomationContext): Promise<void> {
  const chips = surface.locator('button.search-form-filter[aria-label="Remove Filter"]').filter({ hasText: "Check / EFT Number" });
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const count = await chips.count();
    if (count === 0) return;

    await context?.log({
      level: "info",
      message: `Removing ${count} existing Check/EFT search filter chip(s).`,
      eventName: "payment_eob_search_chips_clear",
    });

    for (let index = count - 1; index >= 0; index -= 1) {
      await chips.nth(index).click({ timeout: 5000 }).catch(() => {});
      await surface.waitForTimeout(300);
    }
    await surface.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  }

  const remaining = await chips.count();
  if (remaining > 0) {
    throw new Error(`Unable to clear ${remaining} existing Check/EFT search filter chip(s).`);
  }
}

async function findMatchingResultRows(surface: RemittanceSurface, checkNumber: string, checkDate?: string): Promise<Locator[]> {
  const table = surface.locator('[role="table"][aria-label="Remits"]');
  await table.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
  const resultRows = table.locator('[role="row"]');
  const count = await resultRows.count();
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = resultRows.nth(index);
    const cells = row.locator('[role="cell"]');
    if ((await cells.count()) < 4) continue;
    const displayedCheckNumber = normalizeCheckNumberForComparison(await cells.nth(0).innerText());
    const displayedCheckDate = (await cells.nth(3).innerText()).trim();
    if (displayedCheckNumber === normalizeCheckNumberForComparison(checkNumber) && (!checkDate || displayedCheckDate === checkDate)) {
      matches.push(row);
    }
  }
  return matches;
}

export function checkNumberSearchVariants(checkNumber: string): string[] {
  const exact = normalizeCheckNumber(checkNumber);
  if (!/^\d+$/.test(exact)) return [exact];
  const withoutLeadingZeros = exact.replace(/^0+(?=\d)/, "");
  return [...new Set([exact, withoutLeadingZeros, `0${withoutLeadingZeros}`])];
}

async function searchMatchingRows(
  surface: RemittanceSurface,
  checkNumber: string,
  startDate: string,
  endDate: string,
  exactCheckDate?: string,
): Promise<Locator[]> {
  for (const searchValue of checkNumberSearchVariants(checkNumber)) {
    await clearSearchFilterChips(surface);
    await surface.locator("#checkSearchInput").fill(searchValue);
    await selectCheckSuggestion(surface, searchValue);
    await fillDate(surface.locator("#checkcheckDates-start"), startDate);
    await fillDate(surface.locator("#checkcheckDates-end"), endDate);
    await surface.locator("#checkSearchButton").click();
    await waitForResultsRefresh(surface);
    const matches = await findMatchingResultRows(surface, checkNumber, exactCheckDate);
    if (matches.length) return matches;
  }
  return [];
}

function requireSingleMatchingRow(rows: Locator[], checkNumber: string): Locator | null {
  if (rows.length > 1) {
    throw new Error(`Needs Review - Multiple Matches Found for Check/EFT ${checkNumber}.`);
  }
  return rows[0] ?? null;
}

async function verifyPdf(pdfPath: string): Promise<void> {
  const stats = await fs.stat(pdfPath);
  if (stats.size === 0) throw new Error("Downloaded PDF is empty.");
  const file = await fs.open(pdfPath, "r");
  try {
    const buffer = Buffer.alloc(5);
    await file.read(buffer, 0, 5, 0);
    if (buffer.toString() !== "%PDF-") {
      throw new Error("Downloaded file is not a valid PDF.");
    }
  } finally {
    await file.close();
  }
}

async function clickFirstVisible(candidates: Locator[], timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";

  while (Date.now() < deadline) {
    for (const candidate of candidates) {
      try {
        if (await candidate.first().isVisible({ timeout: 500 })) {
          await candidate.first().click({ timeout: 5000 });
          return;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Unable to click visible menu item after ${timeoutMs}ms.${lastError ? ` Last error: ${lastError}` : ""}`);
}

class NonRetryablePdfDownloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryablePdfDownloadError";
  }
}

async function waitForNewPage(page: Page, timeoutMs: number): Promise<Page | null> {
  const context = page.context();
  const popupPromise = page.waitForEvent("popup", { timeout: timeoutMs }).catch(() => null);
  const pagePromise = context.waitForEvent("page", { timeout: timeoutMs }).catch(() => null);
  return await Promise.race([popupPromise, pagePromise]);
}

async function preparePdfViewerPage(openedPage: Page): Promise<Page> {
  await openedPage.waitForLoadState("domcontentloaded", { timeout: 90000 }).catch(() => {});
  await openedPage.waitForFunction(() => window.location.href.startsWith("blob:"), null, { timeout: 90000 }).catch(() => {});
  await openedPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  return openedPage;
}

async function clickPayerIssuedModalDownload(surface: RemittanceSurface): Promise<boolean> {
  const popover = surface.locator(".popover-body").filter({ has: surface.locator('input[name="documentRadio"]') }).first();
  const title = surface.getByText(/Payer-Issued Remittance Advice Downloads/i).first();
  const modalVisible = await Promise.race([
    popover.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false),
    title.waitFor({ state: "visible", timeout: 3000 }).then(() => true).catch(() => false),
  ]);
  if (!modalVisible) return false;

  const radios = surface.locator('input[name="documentRadio"]');
  const enabledRadio = surface.locator('input[name="documentRadio"]:not(:disabled)').first();
  if (await enabledRadio.count() === 0) {
    const radioCount = await radios.count();
    throw new NonRetryablePdfDownloadError(
      radioCount > 0
        ? "Payer-issued PDF is unavailable because all document options are disabled."
        : "Payer-issued PDF modal has no document options.",
    );
  }

  await enabledRadio.check({ force: true, timeout: 3000 });

  const downloadButton = surface.locator("button.btn-primary").filter({ hasText: /^Download$/ }).first();
  await downloadButton.waitFor({ state: "visible", timeout: 3000 });
  await surface.waitForFunction(() => {
    const buttons = [...document.querySelectorAll("button.btn-primary")];
    return buttons.some((button) => button.textContent?.trim() === "Download" && !button.hasAttribute("disabled"));
  }, null, { timeout: 3000 });
  await downloadButton.click({ timeout: 3000 });
  return true;
}

async function savePdfFromViewerPage(pdfPage: Page, pdfPath: string): Promise<void> {
  const buffer = await readBlobPdfFromViewerPage(pdfPage);
  await fs.writeFile(pdfPath, buffer);
  await verifyPdf(pdfPath);
}

async function waitForPayerIssuedPdf(
  surface: RemittanceSurface,
  page: Page,
  clickPdfIcon: () => Promise<void>,
  pdfPath: string,
): Promise<{ message: string }> {
  const directPagePromise = waitForNewPage(page, 10000);
  const modalPromise = surface.getByText("Payer-Issued Remittance Advice Downloads:", { exact: true })
    .waitFor({ state: "visible", timeout: 5000 })
    .then(() => "modal" as const)
    .catch(() => null);
  let pdfPage: Page | null = null;

  await clickPdfIcon();

  const firstResult = await Promise.race([directPagePromise, modalPromise]);
  if (firstResult && firstResult !== "modal") {
    pdfPage = await preparePdfViewerPage(firstResult);
    try {
      await savePdfFromViewerPage(pdfPage, pdfPath);
    } finally {
      if (!pdfPage.isClosed()) await pdfPage.close().catch(() => {});
    }
    return { message: "Success via payer-issued PDF icon direct tab" };
  }

  const modalDownloadPromise = page.waitForEvent("download", { timeout: 30000 }).catch(() => null);
  const modalPagePromise = waitForNewPage(page, 30000);
  if (await clickPayerIssuedModalDownload(surface)) {
    const modalResult = await Promise.race([modalDownloadPromise, modalPagePromise]);
    if (modalResult && "saveAs" in modalResult) {
      await modalResult.saveAs(pdfPath);
      await verifyPdf(pdfPath);
      return { message: "Success via payer-issued PDF modal download" };
    }
    const modalPage = await modalPagePromise;
    if (modalPage) {
      pdfPage = await preparePdfViewerPage(modalPage);
      try {
        await savePdfFromViewerPage(pdfPage, pdfPath);
      } finally {
        if (!pdfPage.isClosed()) await pdfPage.close().catch(() => {});
      }
      return { message: "Success via payer-issued PDF modal tab" };
    }
  }

  const openedPage = await directPagePromise;
  if (!openedPage) {
    throw new Error("Payer-issued PDF did not open a tab or start a browser download after clicking the row PDF icon.");
  }
  pdfPage = await preparePdfViewerPage(openedPage);
  try {
    await savePdfFromViewerPage(pdfPage, pdfPath);
  } finally {
    if (!pdfPage.isClosed()) await pdfPage.close().catch(() => {});
  }
  return { message: "Success via payer-issued PDF icon direct tab" };
}

async function readBlobPdfFromViewerPage(pdfPage: Page): Promise<Buffer> {
  const base64 = await pdfPage.evaluate(async () => {
    const response = await fetch(window.location.href);
    if (!response.ok) {
      throw new Error(`Blob PDF fetch failed with status ${response.status}.`);
    }
    const contentType = response.headers.get("content-type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    const chunkSize = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return {
      base64: btoa(binary),
      contentType,
    };
  });

  const buffer = Buffer.from(base64.base64, "base64");
  if (base64.contentType && !base64.contentType.toLowerCase().includes("pdf")) {
    // Some blob URLs are served as application/octet-stream. Keep that valid,
    // but fail fast for obvious HTML/error blobs.
    const firstBytes = buffer.subarray(0, 5).toString();
    if (firstBytes !== "%PDF-") {
      throw new Error(`Blob PDF returned unexpected content type "${base64.contentType}".`);
    }
  }
  return buffer;
}

async function downloadFromActionMenu(
  surface: RemittanceSurface,
  page: Page,
  matchingRow: Locator,
  pdfPath: string,
): Promise<void> {
  const menuItemName = "Download Check Summary and Multiple Claims Per Page";
  await matchingRow.getByRole("button", { name: "Action Menu" }).click({ timeout: 15000 });

  const downloadPromise = page.waitForEvent("download", { timeout: 90000 });
  try {
    await clickFirstVisible([
      surface.getByRole("menuitem", { name: menuItemName }),
      page.getByRole("menuitem", { name: menuItemName }),
      surface.locator('[role="menuitem"]').filter({ hasText: menuItemName }),
      page.locator('[role="menuitem"]').filter({ hasText: menuItemName }),
      surface.getByText(menuItemName, { exact: true }),
      page.getByText(menuItemName, { exact: true }),
    ], 3000);
  } catch (error) {
    void downloadPromise.catch(() => {});
    throw error;
  }

  const pdfDownload = await downloadPromise;
  await pdfDownload.saveAs(pdfPath);
  await verifyPdf(pdfPath);
}

async function downloadFromPayerIssuedPdfIcon(
  surface: RemittanceSurface,
  page: Page,
  matchingRow: Locator,
  pdfPath: string,
): Promise<{ message: string }> {
  const pdfButton = matchingRow.getByRole("button", { name: "Download Check Payer-Issued Admittance Advice" });
  return await waitForPayerIssuedPdf(surface, page, async () => {
    await pdfButton.click({ timeout: 10000 });
  }, pdfPath);
}

async function downloadPdfFromMatchingRow(
  surface: RemittanceSurface,
  page: Page,
  matchingRow: Locator,
  record: PaymentEobPortalRecord,
  outputPdfFolder: string,
  context: AutomationContext,
): Promise<{ filename: string; message: string; found: boolean }> {
  const filename = `${safeFilePart(record.checkNumber)}_${dateFilePart(record.checkDate)}.pdf`;
  const pdfPath = path.join(outputPdfFolder, filename);
  let lastError = "";
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await context.log({
        level: "info",
        message: `Opening PDF action menu for ${record.checkNumber} (attempt ${attempt}/${maxAttempts}).`,
        eventName: "payment_eob_pdf_menu_open",
      });
      await matchingRow.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
      await downloadFromActionMenu(surface, page, matchingRow, pdfPath);
      return { filename, message: "Success", found: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await context.log({
        level: "warn",
        message: `Multiple-claims PDF menu download attempt ${attempt}/${maxAttempts} failed for ${record.checkNumber}: ${lastError}`,
        eventName: "payment_eob_pdf_download_retry",
      });
      await page.keyboard.press("Escape").catch(() => {});
      await surface.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      try {
        await context.log({
          level: "info",
          message: `Trying payer-issued PDF icon fallback for ${record.checkNumber} (attempt ${attempt}/${maxAttempts}).`,
          eventName: "payment_eob_pdf_icon_fallback",
        });
        await matchingRow.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
        const fallbackResult = await downloadFromPayerIssuedPdfIcon(surface, page, matchingRow, pdfPath);
        return { filename, message: fallbackResult.message, found: true };
      } catch (fallbackError) {
        lastError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        await context.log({
          level: "warn",
          message: `Payer-issued PDF icon fallback attempt ${attempt}/${maxAttempts} failed for ${record.checkNumber}: ${lastError}`,
          eventName: "payment_eob_pdf_icon_fallback_retry",
        });
        if (fallbackError instanceof NonRetryablePdfDownloadError) {
          break;
        }
      }

      if (attempt < maxAttempts) {
        await page.waitForTimeout(500);
      }
    }
  }

  throw new Error(lastError || `Unable to download PDF for ${record.checkNumber}.`);
}

async function searchAndDownloadPdf(surface: RemittanceSurface, page: Page, record: PaymentEobPortalRecord, outputPdfFolder: string, context: AutomationContext): Promise<{ filename: string; message: string; found: boolean }> {
  try {
    await context.log({ level: "info", message: `Searching Check/EFT ${record.checkNumber} with leading-zero normalization.`, eventName: "payment_eob_normalized_search" });
    const matchingRows = await searchMatchingRows(surface, record.checkNumber, record.checkDate, record.checkDate, record.checkDate);
    const matchingRow = requireSingleMatchingRow(matchingRows, record.checkNumber);
    if (!matchingRow) {
      return { filename: "", message: "No matching result row.", found: false };
    }

    return await downloadPdfFromMatchingRow(surface, page, matchingRow, record, outputPdfFolder, context);
  } finally {
    await clearInput(surface.locator("#checkSearchInput")).catch(() => {});
    await clearInput(surface.locator("#checkcheckDates-start")).catch(() => {});
    await clearInput(surface.locator("#checkcheckDates-end")).catch(() => {});
    await clearSearchFilterChips(surface).catch(() => {});
  }
}

async function searchPendingEftAndDownloadPdf(
  surface: RemittanceSurface,
  page: Page,
  checkNumber: string,
  credentials: PaymentEobCredentials,
  outputPdfFolder: string,
  context: AutomationContext,
): Promise<{ record: PaymentEobPortalRecord; filename: string; message: string; found: boolean }> {
  const startDate = credentials.startDate || daysAgoMmDdYyyy(credentials.lookbackDays);
  const endDate = credentials.endDate || todayMmDdYyyy();
  const emptyRecord: PaymentEobPortalRecord = { checkNumber, checkDate: "", payer: "", payee: "", receivedByAvaility: "", amount: "", raw: {} };
  try {
    await context.log({ level: "info", message: `Searching pending EFT ${checkNumber} with leading-zero normalization.`, eventName: "payment_eob_normalized_search" });
    const matchingRows = await searchMatchingRows(surface, checkNumber, startDate, endDate);
    const matchingRow = requireSingleMatchingRow(matchingRows, checkNumber);
    if (!matchingRow) return { record: emptyRecord, filename: "", message: "No matching result row in the configured lookback range.", found: false };
    const cells = matchingRow.locator('[role="cell"]');
    const record = { ...emptyRecord, checkDate: (await cells.count()) > 3 ? (await cells.nth(3).innerText()).trim() : "" };
    const result = await downloadPdfFromMatchingRow(surface, page, matchingRow, record, outputPdfFolder, context);
    return { record, ...result };
  } finally {
    await clearInput(surface.locator("#checkSearchInput")).catch(() => {});
    await clearInput(surface.locator("#checkcheckDates-start")).catch(() => {});
    await clearInput(surface.locator("#checkcheckDates-end")).catch(() => {});
    await clearSearchFilterChips(surface).catch(() => {});
  }
}

function downloadableFileEvent(filename: string, buffer: Buffer, mimeType: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: buffer.toString("base64"),
    mimeType,
  };
}

async function emitRunZip(outputRoot: string, context: AutomationContext): Promise<void> {
  const datePart = todayYyyyMmDd();
  const runFolder = "run-01";
  const zipRootName = `PaymentEobDownloads/${datePart}/${runFolder}`;
  const zipBuffer = await createStoredZipFromFolder(outputRoot, zipRootName);
  const zipFilename = `PaymentEobDownloads_${datePart}_${runFolder}.zip`;
  await context.emit(downloadableFileEvent(zipFilename, zipBuffer, "application/zip"));
  await context.log({
    level: "info",
    message: `Payment EOB run ZIP is ready: ${zipFilename}. It contains ${zipRootName}/ with PDFs and output files.`,
    eventName: "payment_eob_zip_ready",
  });
}

async function uploadToSharePointIfEnabled(credentials: PaymentEobCredentials, outputRoot: string, context: AutomationContext): Promise<void> {
  if (process.env.PAYMENT_EOB_SHAREPOINT_UPLOAD_ENABLED !== "true") {
    await context.log({
      level: "info",
      message: "SharePoint upload is disabled for now. Set PAYMENT_EOB_SHAREPOINT_UPLOAD_ENABLED=true when the hosted backend is ready.",
      eventName: "payment_eob_sharepoint_disabled",
    });
    return;
  }
  await uploadPaymentEobOutputToSharePoint(credentials, outputRoot, context);
}

export async function runAvailityRemittanceJob(input: RunInput, context: AutomationContext): Promise<void> {
  const outputRoot = path.join(getJobDataPath(context.jobId, "outputs"), `availity-remittance-${context.jobId}`);
  const outputPdfFolder = path.join(outputRoot, "PDFs");
  await fs.mkdir(outputPdfFolder, { recursive: true });

  const referenceNumbers = new Set(input.referenceRows.map((row) => normalizeCheckNumberForComparison(row.checkNumber)));
  const comparisonRows: PaymentEobComparisonRow[] = [];
  const paymentTrackerRows: PaymentTrackerRow[] = [];
  const trackedPayments = new Set<string>();
  const eraDownloadedDate = todayMmDdYyyy();
  const log = async (message: string) => context.log({ level: "info", message });
  let session: Awaited<ReturnType<typeof launchAvailityBrowser>> | null = null;
  let page: Page | null = null;

  await context.emit({ type: "progress", completed: 0, total: 1 });
  try {
    session = await launchAvailityBrowser(log);
    page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(Number(process.env.PORTAL_AVAILITY_REMITTANCE_TIMEOUT_MS || 30000));
    page.setDefaultNavigationTimeout(Number(process.env.PORTAL_AVAILITY_REMITTANCE_NAVIGATION_TIMEOUT_MS || 60000));

    await login(page, input.credentials, context);
    const remittanceSurface = await openRemittanceViewer(page, context, outputRoot);
    await context.log({ level: "info", message: "Availity Remittance Viewer opened.", eventName: "payment_eob_remittance_viewer_opened" });

    const processId = resolveAvailityRemittanceProcess(input.credentials.project || "");
    await context.log({
      level: "info",
      message: `Availity project resolved to ${processId === "charm" ? "CHARM" : "MedRevenue"}${input.credentials.clientName ? ` for client ${input.credentials.clientName}` : ""}.`,
      eventName: "payment_eob_availity_process_resolved",
    });

    if (processId === "medrevenue") {
      if (!input.credentials.clientName?.trim()) throw new Error("MedRevenue Availity credentials must contain a Client Name.");
      const pendingRows = input.referenceRows.filter(isMedRevenuePendingEftRow);
      const seenPending = new Set<string>();
      const uniquePendingRows = pendingRows.filter((row) => {
        const key = normalizeCheckNumberForComparison(row.checkNumber);
        if (seenPending.has(key)) return false;
        seenPending.add(key);
        return true;
      });
      await context.log({
        level: "info",
        message: `MedRevenue Phase 1 found ${uniquePendingRows.length} unique control-log row(s) where Entry Status=Pending and Mode of Payment=EFT.`,
        eventName: "payment_eob_medrevenue_pending_loaded",
      });
      await context.emit({ type: "progress", completed: 0, total: Math.max(uniquePendingRows.length, 1) });
      for (let index = 0; index < uniquePendingRows.length; index += 1) {
        const row = uniquePendingRows[index];
        if (context.isCancelled?.()) break;
        try {
          await context.log({ level: "info", message: `MedRevenue Phase 1 searching pending EFT ${row.checkNumber}.`, eventName: "payment_eob_medrevenue_pending_search", rowIndex: row.rowNumber });
          const result = await searchPendingEftAndDownloadPdf(remittanceSurface, page, row.checkNumber, input.credentials, outputPdfFolder, context);
          const comparisonRow: PaymentEobComparisonRow = {
            checkNumber: row.checkNumber, checkDate: result.record.checkDate, comparison: "Unique",
            searchResult: result.found ? "Found" : "Not found", pdfStatus: result.found ? "Downloaded" : "Not downloaded",
            filename: result.filename, message: `MedRevenue Phase 1: ${result.message}`,
          };
          comparisonRows.push(comparisonRow);
          addPaymentTrackerRow(paymentTrackerRows, trackedPayments, result.record, comparisonRow, eraDownloadedDate);
        } catch (error) {
          comparisonRows.push({ checkNumber: row.checkNumber, checkDate: row.checkDate || "", comparison: "Unique", searchResult: "Error", pdfStatus: "Error", filename: "", message: `MedRevenue Phase 1: ${error instanceof Error ? error.message : String(error)}` });
        }
        await context.emit({ type: "progress", completed: index + 1, total: Math.max(uniquePendingRows.length, 1) });
      }
      await context.log({ level: "info", message: "Starting MedRevenue Phase 2 zero-payments comparison.", eventName: "payment_eob_medrevenue_zero_start" });
    }

    const cancelledBeforeComparison = Boolean(context.isCancelled?.());
    if (cancelledBeforeComparison) {
      await context.emit({ type: "cancelled", message: "Payment EOB download cancelled before the next phase." });
    }
    const portalRecords = cancelledBeforeComparison
      ? []
      : await downloadPortalCsv(remittanceSurface, page, context, outputRoot, input.credentials, { zeroAmount: processId === "medrevenue" });
    const uniqueRecords = portalRecords.filter((record) => {
      if (!referenceNumbers.has(normalizeCheckNumberForComparison(record.checkNumber))) return true;
      comparisonRows.push({ checkNumber: record.checkNumber, checkDate: record.checkDate, comparison: "Existing", searchResult: "Skipped", pdfStatus: "Skipped", filename: "", message: processId === "medrevenue" ? "MedRevenue Phase 2: found in Control Log" : "Found in uploaded Excel" });
      return false;
    });

    await context.emit({ type: "progress", completed: 0, total: Math.max(uniqueRecords.length, 1) });
    for (let index = 0; index < uniqueRecords.length; index += 1) {
      const record = uniqueRecords[index];
      if (context.isCancelled?.()) {
        await context.emit({ type: "cancelled", message: "Payment EOB download cancelled." });
        break;
      }
      try {
        await context.log({ level: "info", message: `${processId === "medrevenue" ? "MedRevenue Phase 2 searching unique zero-payment" : "Searching unmatched"} Check/EFT ${record.checkNumber} (${record.checkDate}).`, eventName: "payment_eob_pdf_search" });
        const result = await searchAndDownloadPdf(remittanceSurface, page, record, outputPdfFolder, context);
        const comparisonRow: PaymentEobComparisonRow = {
          checkNumber: record.checkNumber,
          checkDate: record.checkDate,
          comparison: "Unique",
          searchResult: result.found ? "Found" : "Not found",
          pdfStatus: result.found ? "Downloaded" : "Not downloaded",
          filename: result.filename,
          message: processId === "medrevenue" ? `MedRevenue Phase 2: ${result.message}` : result.message,
        };
        comparisonRows.push(comparisonRow);
        addPaymentTrackerRow(paymentTrackerRows, trackedPayments, record, comparisonRow, eraDownloadedDate);
      } catch (error) {
        comparisonRows.push({
          checkNumber: record.checkNumber,
          checkDate: record.checkDate,
          comparison: "Unique",
          searchResult: "Error",
          pdfStatus: "Error",
          filename: "",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await context.emit({ type: "progress", completed: index + 1, total: Math.max(uniqueRecords.length, 1) });
    }

    if (!portalRecords.length && processId === "charm") {
      for (const row of input.referenceRows) {
        comparisonRows.push({
          checkNumber: row.checkNumber,
          checkDate: row.checkDate || "",
          comparison: "Existing",
          searchResult: "Skipped",
          pdfStatus: "Skipped",
          filename: "",
          message: "No portal CSV records were available for comparison.",
        });
      }
    }

    const workbookBuffer = await createPaymentEobResultWorkbookBuffer(comparisonRows);
    await fs.writeFile(path.join(outputRoot, "comparison_result.xlsx"), workbookBuffer);
    await context.emit(downloadableFileEvent("comparison_result.xlsx", workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));

    const trackerWorkbookBuffer = await createPaymentTrackerWorkbookBuffer(paymentTrackerRows);
    await fs.writeFile(path.join(outputRoot, "payment_tracker.xlsx"), trackerWorkbookBuffer);
    await context.emit(downloadableFileEvent("payment_tracker.xlsx", trackerWorkbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));

    await emitRunZip(outputRoot, context);
    await uploadToSharePointIfEnabled(input.credentials, outputRoot, context);
    await context.log({ level: "info", message: `Payment EOB processing completed. Output folder: ${outputRoot}`, eventName: "payment_eob_completed" });
  } finally {
    if (page && !page.isClosed()) await logoutIfPresent(page).catch(() => {});
    await session?.browser.close().catch(() => {});
  }
}
