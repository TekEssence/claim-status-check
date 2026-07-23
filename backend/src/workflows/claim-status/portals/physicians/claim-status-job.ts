import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Frame, Locator, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { ScraperContext } from "../../types";
import { launchPhysiciansBrowser } from "./browser";
import { physiciansConfig } from "./config";
import {
  normalizeCptCode,
  parsePhysiciansInput,
  readPhysiciansInputWorkbook,
  type PhysiciansInputRow,
} from "./input";
import {
  createPhysiciansOutputWorkbookBuffer,
  type PhysiciansAuditRow,
  type PhysiciansOutputRow,
  type PhysiciansWorkbookState,
} from "./workbook";

type PhysiciansClaimRow = {
  claimNumber: string;
  receivedDate: string;
  serviceDate: string;
  authNumber: string;
  placeOfService: string;
  member: string;
  provider: string;
  organization: string;
  renderingProvider: string;
  payee: string;
  billedAmount: string;
  contractAmount: string;
  netAmount: string;
  company: string;
  outcome: string;
  checkTotalAmount: string;
  authorizationDetails: string;
  serviceLines: PhysiciansServiceLine[];
  rowText: string;
};

type PhysiciansServiceLine = {
  serviceDate: string;
  serviceCode: string;
  modifier: string;
  diagnosisCode: string;
  financialResponsibility: string;
  adjustmentDescription: string;
  paidDate: string;
  checkNumber: string;
  quantity: string;
  billed: string;
  contract: string;
  copay: string;
  coinsurance: string;
  deductible: string;
  adjust: string;
  net: string;
  adminFeeWithhold: string;
  status: string;
  rowText: string;
};

const OUTPUT_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
type SearchSurface = Page | Frame;

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

function normalizeComparableDate(value: string): string {
  const match = value.trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!match) return value.trim();
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  return `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function baseOutputRow(inputRow: PhysiciansInputRow, botStatus: string, botMessage: string): PhysiciansOutputRow {
  return {
    inputData: inputRow,
    inputRowId: inputRow.inputRowId,
    botStatus,
    botMessage,
    memberId: inputRow.memberId,
    dos: inputRow.dos,
    dosTo: inputRow.dosTo,
    cptCode: inputRow.cptCode,
    providerClaimId: inputRow.providerClaimId,
    authorizationNumber: inputRow.authorizationNumber,
    claimNumber: "",
    receivedDate: "",
    serviceDate: "",
    authNumber: "",
    placeOfService: "",
    member: "",
    provider: "",
    organization: "",
    renderingProvider: "",
    payee: "",
    billedAmount: "",
    contractAmount: "",
    netAmount: "",
    company: "",
    outcome: "",
    checkTotalAmount: "",
    authorizationDetails: "",
    serviceLineServiceDate: "",
    serviceCode: "",
    serviceModifier: "",
    diagnosisCode: "",
    financialResponsibility: "",
    adjustmentDescription: "",
    paidDate: "",
    checkNumber: "",
    quantity: "",
    billed: "",
    contract: "",
    copay: "",
    coinsurance: "",
    deductible: "",
    adjust: "",
    net: "",
    adminFeeWithhold: "",
    status: "",
    finalStatus: botMessage,
  };
}

function hasText(value: string): boolean {
  return cleanText(value).length > 0;
}

function appendSentencePart(parts: string[], label: string, value: string): void {
  const text = cleanText(value);
  if (text) parts.push(`${label} ${text}`);
}

function physiciansPaidAmount(result: PhysiciansClaimRow, serviceLine?: PhysiciansServiceLine): string {
  return serviceLine?.net || result.netAmount || result.checkTotalAmount;
}

function physiciansDenialReason(result: PhysiciansClaimRow, serviceLine?: PhysiciansServiceLine): string {
  return serviceLine?.adjustmentDescription || serviceLine?.financialResponsibility || serviceLine?.status || result.outcome;
}

function buildPhysiciansFinalStatusText(inputRow: PhysiciansInputRow, result: PhysiciansClaimRow, serviceLine?: PhysiciansServiceLine): string {
  const dos = inputRow.dos || serviceLine?.serviceDate || result.serviceDate;
  const status = cleanText(serviceLine?.status || result.outcome);
  const receivedDate = result.receivedDate;
  const paidDate = serviceLine?.paidDate || "";
  const checkNumber = serviceLine?.checkNumber || "";
  const paidAmount = physiciansPaidAmount(result, serviceLine);
  const checkTotalAmount = result.checkTotalAmount;
  const denialReason = physiciansDenialReason(result, serviceLine);
  const cptCode = serviceLine?.serviceCode || inputRow.cptCode;
  const lowerStatus = status.toLowerCase();

  const receivedPart = hasText(receivedDate) ? ` claim received on ${receivedDate}` : " claim";
  const suffixParts: string[] = [];
  appendSentencePart(suffixParts, "Claim #", result.claimNumber);
  appendSentencePart(suffixParts, "CPT", cptCode);

  if (/paid|pay|complete/i.test(lowerStatus) && !/denied|deny|rejected/i.test(lowerStatus)) {
    const paidDatePart = hasText(paidDate) ? ` paid on ${paidDate}` : " paid";
    const paidAmountPart = hasText(paidAmount) ? ` paid amount ${paidAmount}` : "";
    const checkPart = hasText(checkNumber) ? ` EFT/Check # ${checkNumber}` : "";
    const checkTotalPart = hasText(checkTotalAmount) ? ` Check Total Amount: ${checkTotalAmount}` : "";
    return cleanText(
      `DOS ${dos}: Checked Physicians portal${receivedPart}${paidDatePart}${paidAmountPart}${checkPart}.${checkTotalPart}. ${suffixParts.join(". ")}.`,
    );
  }

  if (/denied|deny|rejected|not payable|disallow/i.test(lowerStatus) || /denied|deny|rejected|not payable|disallow/i.test(denialReason)) {
    const deniedDatePart = hasText(paidDate) ? ` denied/processed on ${paidDate}` : " denied/processed";
    const reasonPart = hasText(denialReason) ? ` denial reason ${denialReason}` : "";
    return cleanText(`DOS ${dos}: Checked Physicians portal${receivedPart}${deniedDatePart}${reasonPart}. ${suffixParts.join(". ")}.`);
  }

  if (/pending|process|progress|received|open/i.test(lowerStatus)) {
    return cleanText(`DOS ${dos}: Checked Physicians portal${receivedPart} present as In Progress. ${suffixParts.join(". ")}.`);
  }

  const statusPart = hasText(status) ? ` present as ${status}` : " found";
  const amountPart = hasText(paidAmount) ? ` net amount ${paidAmount}` : "";
  const checkTotalPart = hasText(checkTotalAmount) ? ` Check Total Amount: ${checkTotalAmount}.` : "";
  return cleanText(`DOS ${dos}: Checked Physicians portal${receivedPart}${statusPart}${amountPart}.${checkTotalPart} ${suffixParts.join(". ")}.`);
}

function outputRowFromClaim(inputRow: PhysiciansInputRow, result: PhysiciansClaimRow, serviceLine?: PhysiciansServiceLine): PhysiciansOutputRow {
  const finalStatus = buildPhysiciansFinalStatusText(inputRow, result, serviceLine);
  return {
    ...baseOutputRow(inputRow, "Success", "Claim found."),
    claimNumber: result.claimNumber,
    receivedDate: result.receivedDate,
    serviceDate: result.serviceDate,
    authNumber: result.authNumber,
    placeOfService: result.placeOfService,
    member: result.member,
    provider: result.provider,
    organization: result.organization,
    renderingProvider: result.renderingProvider,
    payee: result.payee,
    billedAmount: result.billedAmount,
    contractAmount: result.contractAmount,
    netAmount: result.netAmount,
    company: result.company,
    outcome: result.outcome,
    checkTotalAmount: result.checkTotalAmount,
    authorizationDetails: result.authorizationDetails,
    serviceLineServiceDate: serviceLine?.serviceDate || "",
    serviceCode: serviceLine?.serviceCode || "",
    serviceModifier: serviceLine?.modifier || "",
    diagnosisCode: serviceLine?.diagnosisCode || "",
    financialResponsibility: serviceLine?.financialResponsibility || "",
    adjustmentDescription: serviceLine?.adjustmentDescription || "",
    paidDate: serviceLine?.paidDate || "",
    checkNumber: serviceLine?.checkNumber || "",
    quantity: serviceLine?.quantity || "",
    billed: serviceLine?.billed || "",
    contract: serviceLine?.contract || "",
    copay: serviceLine?.copay || "",
    coinsurance: serviceLine?.coinsurance || "",
    deductible: serviceLine?.deductible || "",
    adjust: serviceLine?.adjust || "",
    net: serviceLine?.net || "",
    adminFeeWithhold: serviceLine?.adminFeeWithhold || "",
    status: serviceLine?.status || "",
    finalStatus,
  };
}

function addAudit(state: PhysiciansWorkbookState, inputRow: PhysiciansInputRow | null, step: string, status: string, message: string): void {
  state.auditRows.push({
    timestamp: nowIso(),
    inputRowId: inputRow?.inputRowId ?? "",
    memberId: inputRow?.memberId ?? "",
    step,
    status,
    message,
  } satisfies PhysiciansAuditRow);
}

async function findVisibleLocator(surface: SearchSurface, selector: string, timeout = 2500): Promise<Locator | null> {
  const locator = surface.locator(selector).first();
  try {
    await locator.waitFor({ state: "visible", timeout });
    return locator;
  } catch {
    return null;
  }
}

async function clickIfVisible(surface: SearchSurface, selector: string, timeout = 2500): Promise<boolean> {
  const locator = await findVisibleLocator(surface, selector, timeout);
  if (!locator) return false;
  await locator.click({ timeout: 5000 }).catch(async () => locator.evaluate((element) => (element as HTMLElement).click()));
  await surface.waitForTimeout(500);
  return true;
}

async function fillField(surface: SearchSurface, selector: string, value: string, label: string): Promise<void> {
  const locator = await findVisibleLocator(surface, selector, 8000);
  if (!locator) throw new Error(`Could not find Physicians field: ${label} (${selector})`);
  await locator.click({ timeout: 5000 });
  await locator.fill("");
  if (value) await locator.fill(value);
}

async function visibleBodyText(surface: SearchSurface): Promise<string> {
  return surface.locator("body").innerText({ timeout: 1500 }).catch(() => "");
}

async function captureDiagnostics(context: ScraperContext, page: Page, inputRow: PhysiciansInputRow | null, reason: string): Promise<void> {
  const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "error";
  const dir = path.join(process.cwd(), ".tmp", "physicians", context.jobId);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const rowLabel = inputRow ? `row-${inputRow.inputRowId}` : "job";
  const screenshotPath = path.join(dir, `${rowLabel}-${safeReason}.jpg`);
  const htmlPath = path.join(dir, `${rowLabel}-${safeReason}.html`);

  const screenshot = await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(htmlPath, html, "utf8").catch(() => {});
    await context.emit({ type: "debug_html", index: inputRow?.inputRowId, html, path: htmlPath, filename: `physicians_${rowLabel}_${safeReason}.html` });
  }
  if (screenshot) {
    await context.emit({ type: "error_screenshot", index: inputRow?.inputRowId, image: screenshot.toString("base64"), path: screenshotPath });
  }
}

async function closeAnnouncementOnce(page: Page): Promise<number> {
  // Do the visibility check AND the click entirely inside page.evaluate(). This sidesteps two
  // Playwright timing issues we were hitting with locator-based clicks: (1) actionability checks
  // failing while the popup is still animating/fading in, and (2) a stale Locator handle pointing
  // at an element that gets replaced/re-added by the time the click actually fires. A raw
  // element.click() from inside the page always reaches the real onclick handler.
  return page
    .evaluate(() => {
      function isVisible(element: Element): boolean {
        const style = window.getComputedStyle(element as HTMLElement);
        const rect = (element as HTMLElement).getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }
      const blocks = Array.from(document.querySelectorAll<HTMLElement>("#block"));
      let closed = 0;
      for (const block of blocks) {
        if (!isVisible(block)) continue;
        const closeLink = block.querySelector<HTMLElement>("a.lnk-Close, a.close, a[onclick*='closeAnnouncement']");
        try {
          closeLink?.click();
        } catch {
          // ignore - we force-hide below regardless of whether the site's own handler worked
        }
        // Don't rely on the portal's own closeAnnouncement() JS actually hiding the element -
        // force it closed ourselves so the automation is never blocked by it either way.
        block.style.setProperty("display", "none", "important");
        closed += 1;
      }
      return closed;
    })
    .catch(() => 0);
}

async function anyAnnouncementVisible(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const blocks = Array.from(document.querySelectorAll<HTMLElement>("#block"));
      return blocks.some((block) => {
        const style = window.getComputedStyle(block);
        const rect = block.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      });
    })
    .catch(() => false);
}

async function closeAnnouncement(page: Page, context: ScraperContext, timeoutMs = 12000): Promise<void> {
  // QuickCap re-shows an announcement popup on essentially every page/section it loads (not just
  // once at login), and can inject it into the DOM slightly after the page otherwise looks ready.
  // Poll for the whole budget rather than a fixed number of attempts so late-arriving popups are
  // still caught.
  const deadline = Date.now() + timeoutMs;
  let totalClosed = 0;
  while (Date.now() < deadline) {
    const closedThisPass = await closeAnnouncementOnce(page);
    totalClosed += closedThisPass;
    await page.waitForTimeout(400);
    if (!(await anyAnnouncementVisible(page))) break;
  }
  if (totalClosed > 0) {
    await context.log({ level: "info", message: `Closed ${totalClosed} Physicians announcement popup(s).` });
  }
}

async function installAnnouncementAutoCloser(page: Page): Promise<void> {
  // Reactive Node-side polling (closeAnnouncement/closeAnnouncementOnce above) still has an
  // inherent gap: the portal can inject the #block popup at any moment, including between our
  // checks. addInitScript runs this INSIDE the browser, before the portal's own scripts on every
  // navigation/AJAX load on this page, and keeps watching continuously - so the popup gets killed
  // within ~150ms of appearing no matter which action of ours triggered it, without depending on
  // any timing from our side at all.
  await page.addInitScript(() => {
    const killAnnouncements = () => {
      document.querySelectorAll<HTMLElement>("#block").forEach((block) => {
        const style = window.getComputedStyle(block);
        const rect = block.getBoundingClientRect();
        const isVisible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        if (!isVisible) return;
        const closeLink = block.querySelector<HTMLElement>("a.lnk-Close, a.close, a[onclick*='closeAnnouncement']");
        try {
          closeLink?.click();
        } catch {
          // ignore - force-hide below regardless
        }
        block.style.setProperty("display", "none", "important");
      });
    };
    killAnnouncements();
    setInterval(killAnnouncements, 150);
    document.addEventListener("DOMContentLoaded", killAnnouncements);
    window.addEventListener("load", () => {
      killAnnouncements();
      new MutationObserver(killAnnouncements).observe(document.documentElement, { childList: true, subtree: true });
    });
  });
}

async function login(page: Page, input: Awaited<ReturnType<typeof parsePhysiciansInput>>, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Physicians QuickCap login page." });
  await page.goto(input.credentials.loginUrl || physiciansConfig.defaultLoginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await fillField(page, physiciansConfig.selectors.username, input.credentials.username, "Username");
  await fillField(page, physiciansConfig.selectors.password, input.credentials.password, "Password");
  await context.log({ level: "info", message: "Submitting Physicians credentials." });
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    clickIfVisible(page, physiciansConfig.selectors.submit, 5000),
  ]);
  await page.waitForTimeout(physiciansConfig.timing.postLoginMs);
  if (await findVisibleLocator(page, physiciansConfig.selectors.password, 1000)) {
    throw new Error("Physicians login failed or did not leave the login form.");
  }
  await closeAnnouncement(page, context);
  await context.log({ level: "info", message: "Physicians login completed." });
}

async function openClaimSearch(page: Page, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Physicians Claims Search/Status page." });
  await closeAnnouncement(page, context);

  const openedByMenu = await page.evaluate(() => {
    // The "Claims" accordion section is expanded by default on this portal, so only click the
    // header when it's actually collapsed - clicking it while already active toggles it CLOSED
    // and hides the "Claims Search/Status" link before we can click it.
    const claimsHeader = Array.from(document.querySelectorAll<HTMLElement>("h3.accordion_header")).find(
      (element) => (element.textContent || "").trim().toLowerCase() === "claims",
    );
    if (claimsHeader && !claimsHeader.classList.contains("active")) {
      claimsHeader.click();
    }
    const link = Array.from(document.querySelectorAll<HTMLAnchorElement>("a")).find((element) =>
      /claims search\/status/i.test(element.textContent || ""),
    );
    if (!link) return false;
    link.click();
    return true;
  }).catch(() => false);

  if (!openedByMenu) {
    await page.goto(physiciansConfig.claimSearchUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  }

  await page.waitForTimeout(physiciansConfig.timing.postNavigationMs);

  const frame = await getClaimSearchFrame(page, context, 25000);
  if (!frame) {
    await captureDiagnostics(context, page, null, "claim-search-not-open");
    throw new Error("Physicians Claim Search page did not open.");
  }
  await context.log({ level: "info", message: "Physicians Claim Search page is ready." });
}

async function getClaimSearchFrame(page: Page, context: ScraperContext, timeoutMs = 15000): Promise<Frame | null> {
  // The PHN shell page only contains navigation and an iframe. The actual claim search form
  // (#txtMemberID, #txtSvcDateFrom_txtDate, #btnSearch, results grid, etc.) is loaded inside
  // iframe#viewFrame from PHNDotNet/ExternalClaimSearch.aspx. Filling the top-level page will
  // always no-op because those controls do not exist there.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await closeAnnouncementOnce(page);

    const directVisible = await page.locator(physiciansConfig.selectors.searchButton).first().isVisible().catch(() => false);
    if (directVisible) {
      await context.log({ level: "warn", message: "Physicians claim search controls were found on the top page instead of viewFrame." }).catch(() => {});
      return page.mainFrame();
    }

    const viewFrame = page.frame({ name: "viewFrame" }) || page.frames().find((frame) => /ExternalClaimSearch\.aspx/i.test(frame.url()));
    if (viewFrame) {
      const ready = await viewFrame.locator(physiciansConfig.selectors.searchButton).first().isVisible().catch(() => false);
      if (ready) return viewFrame;
    }

    await page.waitForTimeout(500);
  }
  return null;
}

async function clearSearch(page: Page, context: ScraperContext): Promise<void> {
  const frame = await getClaimSearchFrame(page, context);
  if (!frame) {
    await openClaimSearch(page, context);
    return;
  }
  const cleared = await clickIfVisible(frame, physiciansConfig.selectors.clearButton, 1800);
  if (cleared) {
    await page.waitForTimeout(physiciansConfig.timing.postNavigationMs);
    await closeAnnouncement(page, context).catch(() => {});
    return;
  }
  await openClaimSearch(page, context);
}

async function setSearchFieldByLabel(surface: SearchSurface, labelPattern: RegExp, value: string): Promise<boolean> {
  if (!value) return false;
  return surface.evaluate(
    ({ source, flags, text }) => {
      const labelRegex = new RegExp(source, flags);
      const clean = (value: string | null | undefined) => String(value ?? "").replace(/\s+/g, " ").trim();
      const labels = Array.from(document.querySelectorAll<HTMLElement>("td, label, span, div"));
      for (const label of labels) {
        if (!labelRegex.test(clean(label.textContent))) continue;
        const container = label.closest("tr") || label.parentElement;
        const field = container?.querySelector<HTMLInputElement>("input[type='text'], input:not([type]), textarea");
        if (!field) continue;
        field.focus();
        field.value = "";
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.value = text;
        field.dispatchEvent(new Event("input", { bubbles: true }));
        field.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    },
    { source: labelPattern.source, flags: labelPattern.flags, text: value },
  ).catch(() => false);
}

async function clearAndFocus(locator: Locator): Promise<void> {
  await locator.click({ timeout: 5000 });
  await locator.press("Control+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  // Belt-and-braces: force the DOM value empty too, in case the field's own key handlers
  // intercepted the select-all/backspace before the value actually cleared.
  await locator.evaluate((element) => {
    (element as HTMLInputElement).value = "";
  }).catch(() => {});
}

async function typeMemberId(surface: SearchSurface, value: string): Promise<void> {
  if (!value) return;
  const locator = await findVisibleLocator(surface, physiciansConfig.selectors.memberId, 8000);
  if (!locator) throw new Error(`Could not find Physicians field: Member ID (${physiciansConfig.selectors.memberId})`);
  await clearAndFocus(locator);
  await locator.pressSequentially(value, { delay: 40 });
  await locator.press("Tab").catch(() => {});
  const actual = await locator.inputValue().catch(() => "");
  if (cleanText(actual) !== cleanText(value)) {
    throw new Error(`Member ID did not fill correctly (expected "${value}", got "${actual}").`);
  }
}

async function typeDateField(surface: SearchSurface, selector: string, value: string, label: string): Promise<void> {
  if (!value) return;
  const locator = await findVisibleLocator(surface, selector, 8000);
  if (!locator) throw new Error(`Could not find Physicians field: ${label} (${selector})`);
  // These date fields have onkeydown/onkeyup handlers (onlynumber/doMask) that build the
  // "##-##-####" mask themselves as each digit is pressed. Playwright's .fill() (and any
  // programmatic value-set / paste) skips those key events entirely, so the field either stays
  // blank or ends up with an unmasked value the site's onblur validator silently rejects - which
  // is why Claim Search was being submitted with empty/invalid dates. Typing digit-by-digit lets
  // the page's own mask logic run exactly like a real user typing would.
  const digits = value.replace(/[^0-9]/g, "");
  await clearAndFocus(locator);
  await locator.pressSequentially(digits, { delay: 60 });
  await locator.press("Tab").catch(() => {});
  const actual = await locator.inputValue().catch(() => "");
  if (normalizeComparableDate(actual) !== normalizeComparableDate(value)) {
    throw new Error(`${label} did not fill correctly (expected "${value}", got "${actual}").`);
  }
}

async function submitSearch(page: Page, inputRow: PhysiciansInputRow, context: ScraperContext): Promise<PhysiciansClaimRow[]> {
  await clearSearch(page, context);
  const frame = await getClaimSearchFrame(page, context);
  if (!frame) throw new Error("Physicians Claim Search frame is not available for data entry.");

  await typeMemberId(frame, inputRow.memberId);
  await typeDateField(frame, physiciansConfig.selectors.serviceDateFrom, inputRow.dos, "Date of Service From");
  await typeDateField(frame, physiciansConfig.selectors.serviceDateTo, inputRow.dosTo || inputRow.dos, "Date of Service To");

  if (inputRow.authorizationNumber) await setSearchFieldByLabel(frame, /authorization\s*#/i, inputRow.authorizationNumber);
  if (inputRow.providerClaimId) await setSearchFieldByLabel(frame, /provider\s*claim|patient\s*account/i, inputRow.providerClaimId);

  await context.log({
    level: "info",
    message: `Searching Physicians row ${inputRow.inputRowId}: Member ID ${maskValue(inputRow.memberId)}, DOS ${inputRow.dos}.`,
    rowIndex: inputRow.inputRowId,
  });

  const clicked = await clickIfVisible(frame, physiciansConfig.selectors.searchButton, 5000);
  if (!clicked) throw new Error("Could not click the Physicians Claim Search button.");
  await page.waitForTimeout(300);
  await closeAnnouncement(page, context).catch(() => {});
  await waitForSearchResults(frame, 20000);
  await page.waitForTimeout(physiciansConfig.timing.postSearchMs);
  return extractClaimRows(frame);
}

async function waitForSearchResults(surface: SearchSurface, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await surface.evaluate(() => {
      const text = document.body?.innerText || "";
      const rows = document.querySelectorAll("#grdClaimsView tr, table[id*='grdClaimsView'] tr").length;
      return { rows, hasNoData: /no claims found|no records found|member not found|no member/i.test(text) };
    }).catch(() => ({ rows: 0, hasNoData: false }));
    if (state.rows > 1 || state.hasNoData) return;
    await surface.waitForTimeout(400);
  }
}

async function extractClaimRows(surface: SearchSurface): Promise<PhysiciansClaimRow[]> {
  return surface.evaluate(() => {
    function clean(value: string | null | undefined): string {
      return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
    function valueByHeader(cells: string[], headers: string[], headerName: string): string {
      const wanted = headerName.toLowerCase();
      const index = headers.findIndex((header) => header.toLowerCase() === wanted);
      return index >= 0 ? cells[index] || "" : "";
    }
    // The service-line grid, the "Check Total Amount" text, and any per-claim Authorization
    // Details block do NOT live inside the claim's own summary <tr>. QuickCap renders each claim
    // as TWO sibling rows: the summary row (claim #, dates, amounts...) followed immediately by a
    // second <tr><td colspan="100%">...</td></tr> that holds the expandable detail content. All
    // three of these must be read from that *next* sibling row, not from the summary row itself.
    function childServiceLines(detailRow: Element | null, idPart: string): PhysiciansServiceLine[] {
      if (!detailRow) return [];
      const table = detailRow.querySelector(`table[id*='${idPart}']`);
      if (!table) return [];
      const headers = Array.from(table.querySelectorAll("th")).map((header) => clean(header.textContent));
      return Array.from(table.querySelectorAll("tr"))
        .slice(1)
        .map((line) => {
          const cellEls = Array.from(line.querySelectorAll("td"));
          if (!cellEls.length) return null;
          const cells = cellEls.map((cell) => clean(cell.textContent));
          if (!cells.some(Boolean)) return null;
          return {
            serviceDate: valueByHeader(cells, headers, "Service Date"),
            serviceCode: valueByHeader(cells, headers, "ServiceCode"),
            modifier: valueByHeader(cells, headers, "Modifier(s)"),
            diagnosisCode: valueByHeader(cells, headers, "Diag. Code"),
            financialResponsibility: valueByHeader(cells, headers, "Financial Resp."),
            adjustmentDescription: valueByHeader(cells, headers, "Adjust Descr."),
            paidDate: valueByHeader(cells, headers, "Paid Date"),
            checkNumber: valueByHeader(cells, headers, "Check #"),
            quantity: valueByHeader(cells, headers, "Qty"),
            billed: valueByHeader(cells, headers, "Billed"),
            contract: valueByHeader(cells, headers, "Contract"),
            copay: valueByHeader(cells, headers, "CoPay"),
            coinsurance: valueByHeader(cells, headers, "Coinsurance"),
            deductible: valueByHeader(cells, headers, "Deductible"),
            adjust: valueByHeader(cells, headers, "Adjust"),
            net: valueByHeader(cells, headers, "Net"),
            adminFeeWithhold: valueByHeader(cells, headers, "Admin. Fee/Withhold"),
            status: valueByHeader(cells, headers, "Status"),
            rowText: cells.join(" "),
          } satisfies PhysiciansServiceLine;
        })
        .filter((line): line is PhysiciansServiceLine => Boolean(line));
    }
    function checkTotalFromDetail(detailRow: Element | null): string {
      if (!detailRow) return "";
      const text = clean(detailRow.textContent);
      return text.match(/Check Total Amount\s*:\s*(\$[\d,.]+)/i)?.[1]?.trim() || "";
    }
    function authorizationText(detailRow: Element | null): string {
      if (!detailRow) return "";
      const authHeader = Array.from(detailRow.querySelectorAll("td, th, div")).find((element) =>
        /authorization details/i.test(clean(element.textContent)),
      );
      const section = authHeader?.closest("tr")?.nextElementSibling || authHeader?.parentElement;
      return clean(section?.textContent || "");
    }

    const table = document.querySelector("#grdClaimsView, table[id*='grdClaimsView']");
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll(":scope > tbody > tr, :scope > tr"));
    const output: PhysiciansClaimRow[] = [];
    for (const row of rows) {
      const directCells = Array.from(row.children).filter((child) => child.tagName.toLowerCase() === "td");
      const cells = directCells.map((cell) => clean(cell.textContent));
      const claimIndex = cells.findIndex((cell) => /^20\d{6,}M/i.test(cell) || /M\d{5,}/i.test(cell));
      if (claimIndex === -1) continue;
      const values = cells.slice(claimIndex);
      const claimNumber = values[0] || "";
      if (!claimNumber) continue;
      const detailRow = row.nextElementSibling;
      output.push({
        claimNumber,
        receivedDate: values[1] || "",
        serviceDate: values[2] || "",
        authNumber: values[3] || "",
        placeOfService: values[4] || "",
        member: values[5] || "",
        provider: values[6] || "",
        organization: values[7] || "",
        renderingProvider: values[8] || "",
        payee: values[9] || "",
        billedAmount: values[10] || "",
        contractAmount: values[11] || "",
        netAmount: values[12] || "",
        company: values[13] || "",
        outcome: values[14] || "",
        checkTotalAmount: checkTotalFromDetail(detailRow),
        authorizationDetails: authorizationText(detailRow),
        serviceLines: childServiceLines(detailRow, "gvChildGrid"),
        rowText: `${clean(row.textContent)} ${clean(detailRow?.textContent || "")}`,
      });
    }
    return output;
  });
}

// The ServiceCode cell renders as two stacked lines: the CPT code, then its description
// (e.g. "99214" / "OFFICE O/P EST MOD 30 MIN"). After cleanText() collapses that to one string
// ("99214 OFFICE O/P EST MOD 30 MIN"), the CPT is always the leading token. Matching on that
// leading token (rather than an "includes" substring search over the whole combined string)
// avoids both false positives and accidentally matching the wrong service line.
function primaryServiceCode(value: string): string {
  const match = value.trim().match(/^([A-Za-z0-9]{4,7})\b/);
  return (match ? match[1] : cleanText(value)).toUpperCase();
}

function rowMatchesInput(row: PhysiciansClaimRow, inputRow: PhysiciansInputRow): boolean {
  const dosMatches = !inputRow.dos || row.rowText.includes(inputRow.dos) || normalizeComparableDate(row.serviceDate) === normalizeComparableDate(inputRow.dos);
  const providerClaimMatches =
    !inputRow.providerClaimId || row.rowText.toUpperCase().includes(cleanText(inputRow.providerClaimId).toUpperCase());
  const authMatches =
    !inputRow.authorizationNumber || row.authNumber.toUpperCase().includes(cleanText(inputRow.authorizationNumber).toUpperCase());
  const wantedCpt = inputRow.cptCode ? normalizeCptCode(inputRow.cptCode).toUpperCase() : "";
  const cptMatches = !wantedCpt || row.serviceLines.some((line) => primaryServiceCode(line.serviceCode) === wantedCpt);
  return dosMatches && providerClaimMatches && authMatches && cptMatches;
}

function serviceLineMatchesInput(serviceLine: PhysiciansServiceLine, inputRow: PhysiciansInputRow): boolean {
  const dosMatches = !inputRow.dos || serviceLine.rowText.includes(inputRow.dos) || normalizeComparableDate(serviceLine.serviceDate) === normalizeComparableDate(inputRow.dos);
  const wantedCpt = inputRow.cptCode ? normalizeCptCode(inputRow.cptCode).toUpperCase() : "";
  const cptMatches = !wantedCpt || primaryServiceCode(serviceLine.serviceCode) === wantedCpt;
  return dosMatches && cptMatches;
}

function parseReceivedDateForSort(value: string): number {
  const iso = normalizeComparableDate(value);
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : time;
}

async function processRow(page: Page, inputRow: PhysiciansInputRow, state: PhysiciansWorkbookState, context: ScraperContext): Promise<void> {
  if (!inputRow.memberId) {
    state.outputRows.push(baseOutputRow(inputRow, "No Member ID", "No Member ID"));
    addAudit(state, inputRow, "validation", "failed", "No Member ID");
    return;
  }
  if (inputRow.validationStatus !== "valid") {
    const status = inputRow.validationMessage || "Invalid row";
    state.outputRows.push(baseOutputRow(inputRow, status, status));
    addAudit(state, inputRow, "validation", "failed", status);
    return;
  }

  addAudit(state, inputRow, "search", "started", "Submitting Physicians claim search.");
  const searchRows = await submitSearch(page, inputRow, context);
  if (!searchRows.length) {
    const frame = await getClaimSearchFrame(page, context, 3000);
    const pageText = await visibleBodyText(frame ?? page.mainFrame());
    const status = /member not found|no member/i.test(pageText) ? "Member Not Found" : "No Claims Found";
    state.outputRows.push(baseOutputRow(inputRow, status, status));
    addAudit(state, inputRow, "search", "completed", status);
    return;
  }

  const matchingRows = searchRows.filter((row) => rowMatchesInput(row, inputRow));
  let selectedRows = matchingRows.length ? matchingRows : searchRows;
  if (matchingRows.length > 1) {
    // Same CPT/DOS can appear on more than one claim when a claim was voided and resubmitted
    // (e.g. an original claim plus a later duplicate/adjustment). Only the most recently received
    // claim reflects the current status, so collapse down to that one.
    const latestReceived = Math.max(...matchingRows.map((row) => parseReceivedDateForSort(row.receivedDate)));
    selectedRows = matchingRows.filter((row) => parseReceivedDateForSort(row.receivedDate) === latestReceived);
  }
  await context.log({
    level: "info",
    message: `Physicians row ${inputRow.inputRowId}: found ${searchRows.length} result(s), extracting ${selectedRows.length} matching result(s).`,
    rowIndex: inputRow.inputRowId,
  });
  for (const result of selectedRows) {
    const matchingServiceLines = result.serviceLines.filter((line) => serviceLineMatchesInput(line, inputRow));
    const selectedServiceLines = matchingServiceLines.length ? matchingServiceLines : result.serviceLines;
    if (selectedServiceLines.length) {
      for (const serviceLine of selectedServiceLines) {
        state.outputRows.push(outputRowFromClaim(inputRow, result, serviceLine));
      }
    } else {
      state.outputRows.push(outputRowFromClaim(inputRow, result));
    }
    addAudit(state, inputRow, "detail", "completed", `Extracted claim ${result.claimNumber}.`);
  }
}

async function emitArtifacts(context: ScraperContext, state: PhysiciansWorkbookState): Promise<void> {
  const workbookBuffer = await createPhysiciansOutputWorkbookBuffer(state);
  await context.emit({
    type: "file_download",
    filename: "physicians_output.xlsx",
    base64: workbookBuffer.toString("base64"),
    mimeType: OUTPUT_MIME,
  });
  const logContent = state.auditRows.map((row) => `[${row.timestamp}] row=${row.inputRowId} ${row.step} ${row.status}: ${row.message}`).join("\n");
  await context.emit({
    type: "file_download",
    filename: "physicians-run.log",
    base64: Buffer.from(logContent, "utf8").toString("base64"),
    mimeType: "text/plain",
  });
}

export async function runPhysiciansClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parsePhysiciansInput(formData);
  const rows = readPhysiciansInputWorkbook(input.inputWorkbookBuffer);
  const state: PhysiciansWorkbookState = { outputRows: [], auditRows: [] };
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    await context.log({ level: "info", message: `Physicians input loaded: ${rows.length} row(s).` });
    await context.emit({ type: "progress", completed: 0, total: rows.length });
    browser = await launchPhysiciansBrowser((message) => context.log({ level: "info", message }));
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    // If the portal ever pops a native alert/confirm dialog (e.g. "please enter search
    // criteria" when a field didn't actually take a value), Playwright blocks all further
    // page actions until the dialog is dismissed. Without this handler that shows up exactly
    // as "just staring at it and closing as error" - auto-dismiss so the row can fail cleanly
    // and the run keeps going instead of hanging.
    page.on("dialog", (dialog) => {
      context.log({ level: "warn", message: `Physicians page dialog appeared: ${dialog.message()}` }).catch(() => {});
      dialog.accept().catch(() => dialog.dismiss().catch(() => {}));
    });
    await installAnnouncementAutoCloser(page);
    await login(page, input, context);
    await openClaimSearch(page, context);

    let completed = 0;
    for (const row of rows) {
      if (context.isCancelled?.()) {
        await context.log({ level: "warn", message: "Physicians run stopped by user. Creating partial output." });
        await context.emit({ type: "cancelled", message: "Physicians scraping stopped. Partial workbook downloaded." });
        break;
      }
      try {
        await processRow(page, row, state, context);
        await clearSearch(page, context);
      } catch (error) {
        const message = errorMessage(error);
        state.outputRows.push(baseOutputRow(row, "Portal Error", message));
        addAudit(state, row, "row_processing", "failed", message);
        if (page) await captureDiagnostics(context, page, row, "row-error");
        await openClaimSearch(page, context).catch(() => {});
      }
      completed += 1;
      await context.emit({ type: "progress", completed, total: rows.length });
      await page.waitForTimeout(physiciansConfig.timing.betweenRowsMs);
    }

    await emitArtifacts(context, state);
    await context.emit({ type: "done" });
  } catch (error) {
    const message = errorMessage(error);
    addAudit(state, null, "job", "failed", message);
    await context.log({ level: "error", message: `Physicians run failed: ${message}` });
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
