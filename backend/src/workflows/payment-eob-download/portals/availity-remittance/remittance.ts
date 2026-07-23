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
} from "../../types";
import { normalizeCheckNumber } from "./input";
import { createPaymentEobResultWorkbookBuffer } from "./output-builder";
import { uploadPaymentEobOutputToSharePoint } from "./sharepoint";
import { createStoredZipFromFolder } from "./zip";

const require = createRequire(import.meta.url);
const { submitLogin } = require("../../../claim-status/portals/availity/legacy/pages/login.page.js");
const { handleMfa } = require("../../../claim-status/portals/availity/legacy/pages/mfa.page.js");
const { acceptCookiesIfPresent, logoutIfPresent } = require("../../../claim-status/portals/availity/legacy/pages/navigation.page.js");

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
  const checkNumber = normalizeCheckNumber(findValue(row, ["Check/EFT #", "Check/EFT Number", "Check EFT Number", "Check Number", "EFT Number"]));
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
    surface.getByText("Remittance Viewer", { exact: true }),
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
  await page.getByRole("button", { name: "Claims & Payments" }).click();
  await page.getByTitle("Remittance Viewer").click();
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

async function dateInputValue(surface: RemittanceSurface, selector: string): Promise<string> {
  return (await surface.locator(selector).inputValue().catch(() => "")).trim();
}

async function filterValuesMatch(surface: RemittanceSurface, organization: string | undefined, startDate: string, endDate: string): Promise<boolean> {
  const selectedOrg = await selectedOrganizationText(surface);
  const selectedStartDate = await dateInputValue(surface, "#checkEFTcheckExchangeDates-start");
  const selectedEndDate = await dateInputValue(surface, "#checkEFTcheckExchangeDates-end");
  return organizationMatches(selectedOrg, organization) && selectedStartDate === startDate && selectedEndDate === endDate;
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

async function downloadPortalCsv(surface: RemittanceSurface, page: Page, context: AutomationContext, outputFolder: string, credentials: PaymentEobCredentials): Promise<PaymentEobPortalRecord[]> {
  const startDate = credentials.startDate || daysAgoMmDdYyyy(credentials.lookbackDays);
  const endDate = credentials.endDate || todayMmDdYyyy();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await context.log({
      level: "info",
      message: `Setting Received by Availity date range ${startDate} - ${endDate} (filter setup attempt ${attempt}/3).`,
      eventName: "payment_eob_date_range",
    });
    await fillDate(surface.locator("#checkEFTcheckExchangeDates-start"), startDate);
    await fillDate(surface.locator("#checkEFTcheckExchangeDates-end"), endDate);
    await surface.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    await context.log({ level: "info", message: "Selecting Availity organization filter.", eventName: "payment_eob_org_select" });
    await selectOrganizationIfProvided(surface, page, credentials.organization, context, outputFolder);
    await surface.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

    const selectedOrg = await selectedOrganizationText(surface);
    const selectedStartDate = await dateInputValue(surface, "#checkEFTcheckExchangeDates-start");
    const selectedEndDate = await dateInputValue(surface, "#checkEFTcheckExchangeDates-end");
    await context.log({
      level: "info",
      message: `Filter verification after attempt ${attempt}/3: Organization="${selectedOrg || "(blank)"}", Received by Availity=${selectedStartDate || "(blank)"} - ${selectedEndDate || "(blank)"}.`,
      eventName: "payment_eob_filter_verify",
    });

    if (await filterValuesMatch(surface, credentials.organization, startDate, endDate)) {
      break;
    }

    if (attempt === 3) {
      await captureDiagnostics(page, outputFolder, "filter-values-not-stable");
      throw new Error(`Unable to keep filter values stable before clicking Filter. Expected Organization="${credentials.organization || "All"}", Received by Availity=${startDate} - ${endDate}. Current Organization="${selectedOrg || "(blank)"}", Received by Availity=${selectedStartDate || "(blank)"} - ${selectedEndDate || "(blank)"}."`);
    }
  }

  const filterButton = surface.locator("#checkFilterButton");
  await context.log({ level: "info", message: "Clicking Filter.", eventName: "payment_eob_filter_click" });
  await filterButton.click();
  await waitForResultsRefresh(surface);
  await context.log({ level: "info", message: "Filtered results loaded.", eventName: "payment_eob_filter_loaded" });

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

async function findMatchingResultRow(surface: RemittanceSurface, checkNumber: string, checkDate: string): Promise<Locator | null> {
  const table = surface.locator('[role="table"][aria-label="Remits"]');
  await table.waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
  const resultRows = table.locator('[role="row"]');
  const count = await resultRows.count();
  for (let index = 0; index < count; index += 1) {
    const row = resultRows.nth(index);
    const cells = row.locator('[role="cell"]');
    if ((await cells.count()) < 4) continue;
    const displayedCheckNumber = normalizeCheckNumber(await cells.nth(0).innerText());
    const displayedCheckDate = (await cells.nth(3).innerText()).trim();
    if (displayedCheckNumber === normalizeCheckNumber(checkNumber) && displayedCheckDate === checkDate) {
      return row;
    }
  }
  return null;
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

async function waitForPdfViewerPage(page: Page, clickPdfIcon: () => Promise<void>): Promise<Page> {
  const context = page.context();
  const popupPromise = page.waitForEvent("popup", { timeout: 90000 }).catch(() => null);
  const pagePromise = context.waitForEvent("page", { timeout: 90000 }).catch(() => null);

  await clickPdfIcon();

  const openedPage = await Promise.race([popupPromise, pagePromise]);
  if (!openedPage) {
    throw new Error("Payer-issued PDF tab did not open after clicking the row PDF icon.");
  }

  await openedPage.waitForLoadState("domcontentloaded", { timeout: 90000 }).catch(() => {});
  await openedPage.waitForFunction(() => window.location.href.startsWith("blob:"), null, { timeout: 90000 }).catch(() => {});
  await openedPage.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  return openedPage;
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
    ], 10000);
  } catch (error) {
    void downloadPromise.catch(() => {});
    throw error;
  }

  const pdfDownload = await downloadPromise;
  await pdfDownload.saveAs(pdfPath);
  await verifyPdf(pdfPath);
}

async function downloadFromPayerIssuedPdfIcon(
  page: Page,
  matchingRow: Locator,
  pdfPath: string,
): Promise<void> {
  const pdfButton = matchingRow.getByRole("button", { name: "Download Check Payer-Issued Admittance Advice" });
  let pdfPage: Page | null = null;
  try {
    pdfPage = await waitForPdfViewerPage(page, async () => {
      await pdfButton.click({ timeout: 30000 });
    });

    const buffer = await readBlobPdfFromViewerPage(pdfPage);
    await fs.writeFile(pdfPath, buffer);
    await verifyPdf(pdfPath);
  } finally {
    if (pdfPage && !pdfPage.isClosed()) await pdfPage.close().catch(() => {});
  }
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

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await context.log({
        level: "info",
        message: `Opening PDF action menu for ${record.checkNumber} (attempt ${attempt}/3).`,
        eventName: "payment_eob_pdf_menu_open",
      });
      await matchingRow.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
      await downloadFromActionMenu(surface, page, matchingRow, pdfPath);
      return { filename, message: "Success", found: true };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await context.log({
        level: "warn",
        message: `Multiple-claims PDF menu download attempt ${attempt}/3 failed for ${record.checkNumber}: ${lastError}`,
        eventName: "payment_eob_pdf_download_retry",
      });
      await page.keyboard.press("Escape").catch(() => {});
      await surface.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});

      try {
        await context.log({
          level: "info",
          message: `Trying payer-issued PDF icon fallback for ${record.checkNumber} (attempt ${attempt}/3).`,
          eventName: "payment_eob_pdf_icon_fallback",
        });
        await matchingRow.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
        await downloadFromPayerIssuedPdfIcon(page, matchingRow, pdfPath);
        return { filename, message: "Success via payer-issued PDF icon", found: true };
      } catch (fallbackError) {
        lastError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
        await context.log({
          level: "warn",
          message: `Payer-issued PDF icon fallback attempt ${attempt}/3 failed for ${record.checkNumber}: ${lastError}`,
          eventName: "payment_eob_pdf_icon_fallback_retry",
        });
      }

      if (attempt < 3) {
        await page.waitForTimeout(2000);
      }
    }
  }

  throw new Error(lastError || `Unable to download PDF for ${record.checkNumber}.`);
}

async function searchAndDownloadPdf(surface: RemittanceSurface, page: Page, record: PaymentEobPortalRecord, outputPdfFolder: string, context: AutomationContext): Promise<{ filename: string; message: string; found: boolean }> {
  try {
    await clearSearchFilterChips(surface, context);
    await surface.locator("#checkSearchInput").fill(record.checkNumber);
    await selectCheckSuggestion(surface, record.checkNumber);
    await fillDate(surface.locator("#checkcheckDates-start"), record.checkDate);
    await fillDate(surface.locator("#checkcheckDates-end"), record.checkDate);
    await surface.locator("#checkSearchButton").click();

    const matchingRow = await findMatchingResultRow(surface, record.checkNumber, record.checkDate);
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

  const referenceNumbers = new Set(input.referenceRows.map((row) => row.checkNumber));
  const comparisonRows: PaymentEobComparisonRow[] = [];
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

    const portalRecords = await downloadPortalCsv(remittanceSurface, page, context, outputRoot, input.credentials);
    const uniqueRecords = portalRecords.filter((record) => {
      if (referenceNumbers.has(record.checkNumber)) {
        comparisonRows.push({
          checkNumber: record.checkNumber,
          checkDate: record.checkDate,
          comparison: "Existing",
          searchResult: "Skipped",
          pdfStatus: "Skipped",
          filename: "",
          message: "Found in uploaded Excel",
        });
        return false;
      }
      return true;
    });

    await context.emit({ type: "progress", completed: 0, total: Math.max(uniqueRecords.length, 1) });
    for (let index = 0; index < uniqueRecords.length; index += 1) {
      const record = uniqueRecords[index];
      if (context.isCancelled?.()) {
        await context.emit({ type: "cancelled", message: "Payment EOB download cancelled." });
        break;
      }
      try {
        await context.log({ level: "info", message: `Searching unmatched Check/EFT ${record.checkNumber} (${record.checkDate}).`, eventName: "payment_eob_pdf_search" });
        const result = await searchAndDownloadPdf(remittanceSurface, page, record, outputPdfFolder, context);
        comparisonRows.push({
          checkNumber: record.checkNumber,
          checkDate: record.checkDate,
          comparison: "Unique",
          searchResult: result.found ? "Found" : "Not found",
          pdfStatus: result.found ? "Downloaded" : "Not downloaded",
          filename: result.filename,
          message: result.message,
        });
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

    if (!portalRecords.length) {
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

    await emitRunZip(outputRoot, context);
    await uploadToSharePointIfEnabled(input.credentials, outputRoot, context);
    await context.log({ level: "info", message: `Payment EOB processing completed. Output folder: ${outputRoot}`, eventName: "payment_eob_completed" });
  } finally {
    if (page && !page.isClosed()) await logoutIfPresent(page).catch(() => {});
    await session?.browser.close().catch(() => {});
  }
}
