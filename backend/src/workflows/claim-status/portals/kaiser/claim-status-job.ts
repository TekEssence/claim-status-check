import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Frame, Locator, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { ScraperContext } from "../../types";
import { launchKaiserBrowser } from "./browser";
import { kaiserConfig } from "./config";
import { extractCptFromServiceText, normalizeCptCode, parseKaiserInput, readKaiserInputWorkbook, type KaiserInputRow } from "./input";
import { createKaiserOutputWorkbookBuffer, type KaiserAuditRow, type KaiserOutputRow, type KaiserWorkbookState } from "./workbook";

type ClaimSearchRow = {
  claimNumber: string;
  cells: Record<string, string>;
  rowIndex: number;
  rowText: string;
};

type ClaimTableSnapshot = {
  found: boolean;
  rowCount: number;
  signature: string;
  rowTexts: string[];
};

type ServiceLine = {
  number: string;
  service: string;
  from: string;
  to: string;
  modifiers: string;
  quantity: string;
  claimCodes: string;
  billed: string;
  allowed: string;
  notCovered: string;
  deductible: string;
  coinsurance: string;
  copay: string;
  exceededBenefit: string;
  patientTotal: string;
  netPayable: string;
};

type ClaimDetails = {
  claimNumber: string;
  status: string;
  checkEft: string;
  paymentDate: string;
  paymentAmount: string;
  claimCodeDescriptionTable: string;
  claimCodeDescriptions: Record<string, string>;
  claimLevelCodes: string;
  serviceLevelDescription: string;
  services: ServiceLine[];
};

type ClaimDetailsExtraction = ClaimDetails & {
  framesInspected: number;
  frameUrls: string[];
  servicesSectionFound: boolean;
  servicesTableFound: boolean;
  claimLevelFound: boolean;
  serviceLevelFound: boolean;
  diagnostics: Array<{
    frameUrl: string;
    servicesSectionFound: boolean;
    servicesTableFound: boolean;
    servicesRowsFound: number;
    servicesSectionText: string;
    tablesInsideServicesSection: number;
    headerRowsDetected: string[][];
    directCellRowsFound: string[][];
  }>;
};

const OUTPUT_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function moneyToNumber(value: string): number {
  const amount = Number(value.replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function splitClaimCodes(value: string): string[] {
  return value
    .split(/[,\s/]+/)
    .map((code) => code.trim().toUpperCase())
    .filter(Boolean);
}

function serviceCodeFromText(value: string): string {
  return extractCptFromServiceText(value);
}

function claimCodeDescriptionsForService(details: ClaimDetails, service: ServiceLine): string {
  if (moneyToNumber(service.netPayable) > 0) return "";
  const descriptions = splitClaimCodes(service.claimCodes)
    .map((code) => details.claimCodeDescriptions[code])
    .filter(Boolean);
  return descriptions.join("; ");
}

function unpaidServiceLines(details: ClaimDetails): ServiceLine[] {
  return details.services.filter((line) => moneyToNumber(line.netPayable) <= 0);
}

function serviceLevelDenialForService(details: ClaimDetails, service: ServiceLine): string {
  const text = cleanText(details.serviceLevelDescription);
  if (!text || /no service-level claim codes/i.test(text)) return "";
  if (moneyToNumber(service.netPayable) > 0) return "";

  const serviceCpt = serviceCodeFromText(service.service);
  if (serviceCpt && text.toUpperCase().includes(serviceCpt)) return text;

  if (details.services.length === 1) return text;

  // Multi-service claim and the Service-Level text doesn't name a CPT (Kaiser's Service-Level
  // description text normally doesn't). Per the Kaiser spec: the description belongs to
  // whichever line got $0 Net Payable, not the line that was actually paid. Only attach it
  // when exactly one line is unpaid, so we never guess when several lines are denied.
  const unpaid = unpaidServiceLines(details);
  if (unpaid.length === 1 && unpaid[0] === service) return text;
  return "";
}

function claimLevelAppliesToService(details: ClaimDetails, service: ServiceLine): boolean {
  if (!details.claimLevelCodes.trim() || moneyToNumber(service.netPayable) > 0) return false;
  if (details.services.length === 1) return true;

  const unpaid = unpaidServiceLines(details);
  return unpaid.length === 1 && unpaid[0] === service;
}

function serviceSpecificDenial(details: ClaimDetails, service: ServiceLine): { text: string; source: string } {
  if (moneyToNumber(service.netPayable) > 0) return { text: "", source: "" };

  const serviceLevel = serviceLevelDenialForService(details, service);
  if (serviceLevel) return { text: serviceLevel, source: "Service-Level" };

  const codeDescriptions = claimCodeDescriptionsForService(details, service);
  if (codeDescriptions) return { text: codeDescriptions, source: "Claim Codes" };

  if (claimLevelAppliesToService(details, service)) {
    return { text: cleanText(details.claimLevelCodes), source: "Claim-Level" };
  }

  return { text: "", source: "" };
}

function dateRangeForDos(dos: string): { fromDate: string; toDate: string } {
  return { fromDate: dos, toDate: dos };
}

function normalizeSearchValue(value: string): string {
  return value.replace(/\s+/g, "").trim().toUpperCase();
}

function normalizePatientName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function patientNameTokens(value: string): string[] {
  const noNicknames = value.replace(/"[^"]*"/g, " ");
  return normalizePatientName(noNicknames)
    .split(" ")
    .map((token) => token.trim())
    .filter(Boolean)
    .sort();
}

function patientNamesMatch(portalName: string, excelName: string): boolean {
  const portalTokens = patientNameTokens(portalName);
  const excelTokens = patientNameTokens(excelName);
  if (!portalTokens.length || !excelTokens.length) return false;
  return excelTokens.every((token) => portalTokens.includes(token));
}

function normalizeDateValue(value: string): string {
  const text = value.trim();
  const match = text.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!match) return text;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = Number(match[3]);
  const year = rawYear < 100 ? 2000 + rawYear : rawYear;
  if (!month || !day || !year) return text;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function getCell(cells: Record<string, string>, names: string[]): string {
  const normalizedNames = names.map((name) => name.toLowerCase().replace(/[^a-z0-9]+/g, ""));
  for (const [key, value] of Object.entries(cells)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (normalizedNames.includes(normalizedKey)) return value;
  }
  return "";
}

function maskValue(value: string): string {
  const normalized = value.trim();
  if (normalized.length <= 4) return "****";
  return `${"*".repeat(Math.max(0, normalized.length - 4))}${normalized.slice(-4)}`;
}

function baseOutputRow(inputRow: KaiserInputRow, botStatus: string, botMessage: string): KaiserOutputRow {
  return {
    inputData: inputRow,
    inputRowId: inputRow.inputRowId,
    botStatus,
    botMessage,
    memberId: inputRow.memberId,
    dos: inputRow.dos,
    cptCode: inputRow.cptCode,
    claimNumber: "",
    claimStatus: "",
    checkEft: "",
    paymentDate: "",
    paymentAmount: "",
    service: "",
    serviceFrom: "",
    serviceTo: "",
    modifiers: "",
    quantity: "",
    claimCodes: "",
    billed: "",
    allowed: "",
    notCovered: "",
    deductible: "",
    coinsurance: "",
    copay: "",
    exceededBenefit: "",
    patientTotal: "",
    netPayable: "",
    claimCodeDescriptionTable: "",
    claimLevelCodes: "",
    serviceLevelDescription: "",
    denialSource: "",
    finalStatus: botMessage,
  };
}

function outputRowFromClaim(inputRow: KaiserInputRow, details: ClaimDetails, service: ServiceLine): KaiserOutputRow {
  const serviceDenial = serviceSpecificDenial(details, service);
  const paymentText = details.checkEft
    ? ` EFT/Check # ${details.checkEft}`
    : "";
  const statusText = moneyToNumber(service.netPayable) > 0
    ? `DOS ${inputRow.dos}: Kaiser claim ${details.claimNumber} ${details.status || "found"} paid amount ${service.netPayable || details.paymentAmount}.${paymentText}`
    : `DOS ${inputRow.dos}: Kaiser claim ${details.claimNumber} ${details.status || "found"} matched CPT ${inputRow.cptCode} with net payable ${service.netPayable || "0.00"}. ${serviceDenial.text || service.claimCodes || "No denial reason found."}`;

  return {
    ...baseOutputRow(inputRow, "Success", "Claim found."),
    claimNumber: details.claimNumber,
    claimStatus: details.status,
    checkEft: details.checkEft,
    paymentDate: details.paymentDate,
    paymentAmount: details.paymentAmount,
    service: service.service,
    serviceFrom: service.from,
    serviceTo: service.to,
    modifiers: service.modifiers,
    quantity: service.quantity,
    claimCodes: service.claimCodes,
    billed: service.billed,
    allowed: service.allowed,
    notCovered: service.notCovered,
    deductible: service.deductible,
    coinsurance: service.coinsurance,
    copay: service.copay,
    exceededBenefit: service.exceededBenefit,
    patientTotal: service.patientTotal,
    netPayable: service.netPayable,
    claimCodeDescriptionTable: details.claimCodeDescriptionTable,
    claimLevelCodes: details.claimLevelCodes,
    serviceLevelDescription: serviceDenial.text,
    denialSource: serviceDenial.source,
    finalStatus: cleanText(statusText),
  };
}

function addAudit(state: KaiserWorkbookState, inputRow: KaiserInputRow | null, step: string, status: string, message: string): void {
  state.auditRows.push({
    timestamp: nowIso(),
    inputRowId: inputRow?.inputRowId ?? "",
    memberId: inputRow?.memberId ?? "",
    step,
    status,
    message,
  } satisfies KaiserAuditRow);
}

async function findVisibleLocator(page: Page, selector: string, timeout = 1500): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const candidates: Array<Page | Frame> = [page, ...page.frames()];
    for (const candidate of candidates) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const locator = candidate.locator(selector).first();
      try {
        await locator.waitFor({ state: "visible", timeout: Math.min(remaining, 120) });
        return locator;
      } catch {
        // Try the next frame without multiplying the total timeout.
      }
    }
  }
  return null;
}

async function clickIfVisible(page: Page, selector: string, timeout = 1200): Promise<boolean> {
  const locator = await findVisibleLocator(page, selector, timeout);
  if (!locator) return false;
  await locator.click({ timeout: 5000 }).catch(async () => locator.evaluate((element) => (element as HTMLElement).click()));
  await page.waitForTimeout(450);
  return true;
}

async function fillVisible(page: Page, selector: string, value: string): Promise<void> {
  const locator = await findVisibleLocator(page, selector, 3000);
  if (!locator) throw new Error(`Could not find Kaiser field: ${selector}`);
  await locator.fill("");
  await page.waitForTimeout(150);
  await locator.fill(value);
  await page.waitForTimeout(300);
}

async function humanPause(page: Page, ms = 350): Promise<void> {
  await page.waitForTimeout(ms);
}

async function typeVisibleLikeHuman(page: Page, selector: string, value: string, delay = 80): Promise<void> {
  const locator = await findVisibleLocator(page, selector, 3000);
  if (!locator) throw new Error(`Could not find Kaiser login field: ${selector}`);
  await locator.click();
  await humanPause(page, 250);
  await page.keyboard.press("Control+A");
  await humanPause(page, 120);
  await page.keyboard.press("Backspace");
  await humanPause(page, 180);
  await locator.pressSequentially(value, { delay });
  await humanPause(page, 300);
}

async function pressVisible(page: Page, selector: string, key: string): Promise<void> {
  const locator = await findVisibleLocator(page, selector, 2000);
  if (!locator) throw new Error(`Could not find Kaiser field for key press: ${selector}`);
  await locator.press(key);
  await page.waitForTimeout(300);
}

async function visibleBodyText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
}

async function isSessionUnavailable(page: Page): Promise<boolean> {
  const bodyText = await visibleBodyText(page);
  if (/you have signed off|session.*(expired|ended)|sign on again|please sign on/i.test(bodyText)) return true;
  return Boolean(await findVisibleLocator(page, kaiserConfig.selectors.password, 500));
}

async function captureDiagnostics(context: ScraperContext, page: Page, inputRow: KaiserInputRow | null, reason: string): Promise<void> {
  const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "error";
  const dir = path.join(process.cwd(), ".tmp", "kaiser", context.jobId);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const rowLabel = inputRow ? `row-${inputRow.inputRowId}` : "job";
  const screenshotPath = path.join(dir, `${rowLabel}-${safeReason}.jpg`);
  const htmlPath = path.join(dir, `${rowLabel}-${safeReason}.html`);

  const screenshot = await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(htmlPath, html, "utf8").catch(() => {});
    await context.emit({
      type: "debug_html",
      index: inputRow ? inputRow.inputRowId : undefined,
      html,
      path: htmlPath,
      filename: `kaiser_${rowLabel}_${safeReason}.html`,
    });
  }
  if (screenshot) {
    await context.emit({
      type: "error_screenshot",
      index: inputRow ? inputRow.inputRowId : undefined,
      image: screenshot.toString("base64"),
      path: screenshotPath,
    });
  }
}

async function login(page: Page, input: Awaited<ReturnType<typeof parseKaiserInput>>, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Kaiser EpicLink sign on page." });
  await page.goto(input.credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

  for (let attempt = 1; attempt <= 2; attempt++) {
    await context.log({ level: "info", message: `Typing Kaiser credentials${attempt > 1 ? ` after signed-off retry ${attempt}` : ""}.` });
    await typeVisibleLikeHuman(page, kaiserConfig.selectors.username, input.credentials.username, 80);
    await typeVisibleLikeHuman(page, kaiserConfig.selectors.password, input.credentials.password, 80);
    await context.log({ level: "info", message: "Submitting Kaiser sign on form." });
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
      clickIfVisible(page, kaiserConfig.selectors.submit, 3000),
    ]);
    await page.waitForTimeout(1500);

    const signedOffAgain = await clickIfVisible(page, "a:has-text('Sign on again')", 700);
    if (!signedOffAgain) break;

    await context.log({ level: "warn", message: "Kaiser showed signed-off page after login. Clicking Sign on again and retrying login." });
    await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    await findVisibleLocator(page, kaiserConfig.selectors.username, 15000);
  }

  const stillOnLogin = await findVisibleLocator(page, kaiserConfig.selectors.password, 1000);
  if (stillOnLogin) {
    throw new Error("Kaiser login failed or did not leave the sign on page.");
  }

  await context.log({ level: "info", message: "Checking for optional Kaiser browser warning popup." });
  if (await clickIfVisible(page, kaiserConfig.selectors.fontDialogOk, 600)) {
    await context.log({ level: "info", message: "Kaiser browser warning popup closed." });
  }
  await context.log({ level: "info", message: "Kaiser login completed." });
}

async function openClaimSearch(page: Page, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Kaiser Claim Search from home page." });
  let opened = await clickIfVisible(page, kaiserConfig.selectors.claimSearchCard, 1500);
  if (opened) {
    await context.log({ level: "info", message: "Clicked Kaiser Claim Search quick action." });
    await page.waitForTimeout(1200);
  }

  if (!opened) {
    await context.log({ level: "info", message: "Claim Search quick action was not clickable; using Kaiser menu frame fallback." });
    opened = await page.evaluate(() => {
      const menuFrame = (window.top as any)?.sMenuFrame;
      if (menuFrame && typeof menuFrame.loadSub === "function") {
        menuFrame.loadSub("claims_claimprovreview");
        return true;
      }
      return false;
    }).catch(() => false);
    if (opened) {
      await context.log({ level: "info", message: "Kaiser menu frame fallback opened Claim Search." });
      await page.waitForTimeout(1200);
    }
  }

  if (!opened) {
    await context.log({ level: "info", message: "Using Kaiser top navigation fallback for Claim Search." });
    await clickIfVisible(page, kaiserConfig.selectors.claimsTopNav, 2000);
    await clickIfVisible(page, kaiserConfig.selectors.claimSearchTab, 2000);
  }

  await context.log({ level: "info", message: "Waiting for Kaiser Claim Search fields." });
  await findVisibleLocator(page, kaiserConfig.selectors.megaSearch, 5000);
  await findVisibleLocator(page, kaiserConfig.selectors.fromDate, 5000);
  await context.log({ level: "info", message: "TRACE 1: Claim Search page detected." });
  await context.log({ level: "info", message: "Kaiser Claim Search page is ready." });
}

async function getMegaSearchDropdownOptions(page: Page): Promise<string[]> {
  const optionSets = await Promise.all(
    [page.mainFrame(), ...page.frames()].map((frame) =>
      frame.evaluate(() => {
        function visible(element: Element): boolean {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
        }

        return Array.from(document.querySelectorAll("li, div, tr, a, span"))
          .filter((element) => visible(element))
          .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
          .filter((text) => /^(Submitted ID|Claim ID|Check Number|Member ID)\s*:/i.test(text));
      }).catch(() => [] as string[]),
    ),
  );

  return Array.from(new Set(optionSets.flat()));
}

async function clickMegaSearchMemberIdOption(page: Page, memberId: string, context: ScraperContext, rowIndex: number): Promise<boolean> {
  await page.waitForTimeout(kaiserConfig.timing.dropdownSettleMs);
  const normalizedMemberId = normalizeSearchValue(memberId);
  const options = await getMegaSearchDropdownOptions(page);
  await context.log({
    level: "info",
    message: `Found dropdown options: ${options.map((option) => option.split(":")[0]?.trim()).filter(Boolean).join(", ") || "none"}.`,
    rowIndex,
  });

  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const clicked = await frame.evaluate((args) => {
      function visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      const rowSelectors = [
        ".ui-menu-item",
        ".ui-menu-item-wrapper",
        "[role='option']",
        "li",
        "tr",
        "a",
        "div",
      ].join(",");
      const candidates = Array.from(document.querySelectorAll(rowSelectors))
        .filter((element) => visible(element))
        .filter((element) => {
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          const match = text.match(/^Member ID\s*:\s*(.+)$/i);
          if (!match) return false;
          return match[1].replace(/\s+/g, "").trim().toUpperCase() === args.normalizedMemberId;
        })
        .sort((left, right) => (left.textContent || "").length - (right.textContent || "").length);

      const target = candidates[0] as HTMLElement | undefined;
      if (target) {
        target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
        target.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
        target.click();
      }
      return Boolean(target);
    }, { normalizedMemberId }).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

async function getSelectedMegaSearchCriteria(page: Page, memberId: string): Promise<string> {
  const normalizedMemberId = normalizeSearchValue(memberId);
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const criterion = await frame.evaluate((args) => {
      function visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      const criteria = ["Submitted ID", "Claim ID", "Check Number", "Member ID"];
      for (const element of Array.from(document.querySelectorAll("div, span, li, a"))) {
        if (!visible(element)) continue;
        if (element.closest(".ui-autocomplete, .ui-menu, [role='listbox']")) continue;
        const text = (element.textContent || "").replace(/\s+/g, " ").trim();
        if (/Additional Criteria/i.test(text)) continue;
        const match = text.match(/\b(Submitted ID|Claim ID|Check Number|Member ID)\s*:\s*([A-Za-z0-9-]+)/i);
        if (!match) continue;
        if (match[2].replace(/\s+/g, "").trim().toUpperCase() !== args.normalizedMemberId) continue;
        const label = criteria.find((candidate) => candidate.toLowerCase() === match[1].toLowerCase());
        if (label) return label;
      }
      return "";
    }, { normalizedMemberId }).catch(() => "");
    if (criterion) return criterion;
  }
  return "";
}

async function hasSelectedMemberIdChip(page: Page, memberId: string): Promise<boolean> {
  return (await getSelectedMegaSearchCriteria(page, memberId)) === "Member ID";
}

async function clearMegaSearchCriteria(page: Page, memberId: string): Promise<void> {
  const normalizedMemberId = normalizeSearchValue(memberId);
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const cleared = await frame.evaluate((args) => {
      function visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }

      const chips = Array.from(document.querySelectorAll("div, span, li"))
        .filter((element) => visible(element))
        .filter((element) => !element.closest(".ui-autocomplete, .ui-menu, [role='listbox']"))
        .filter((element) => {
          const text = (element.textContent || "").replace(/\s+/g, " ").trim();
          const match = text.match(/\b(Submitted ID|Claim ID|Check Number|Member ID)\s*:\s*([A-Za-z0-9-]+)/i);
          return Boolean(match && match[2].replace(/\s+/g, "").trim().toUpperCase() === args.normalizedMemberId);
        })
        .sort((left, right) => (left.textContent || "").length - (right.textContent || "").length);

      const chip = chips[0] as HTMLElement | undefined;
      const closeTarget = chip?.querySelector("button, a, [role='button'], .close, .remove, .ui-icon-close, .fa-times, .glyphicon-remove") as HTMLElement | null;
      if (closeTarget) {
        closeTarget.click();
        return true;
      }

      const text = chip?.textContent || "";
      if (chip && /[\u00d7x]\s*$/.test(text)) {
        chip.click();
        return true;
      }
      return false;
    }, { normalizedMemberId }).catch(() => false);
    if (cleared) {
      await page.waitForTimeout(kaiserConfig.timing.retryBackoffMs);
      return;
    }
  }
}

async function waitForDropdownClosed(page: Page): Promise<void> {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    const options = await getMegaSearchDropdownOptions(page);
    if (options.length === 0) return;
    await page.waitForTimeout(kaiserConfig.timing.stablePollMs);
  }
}

async function selectMemberIdFromMegaSearch(page: Page, memberId: string, context: ScraperContext, rowIndex: number): Promise<boolean> {
  const megaSearch = await findVisibleLocator(page, kaiserConfig.selectors.megaSearch, 3000);
  if (!megaSearch) throw new Error("Could not find Kaiser claim search box.");

  const enterMemberId = async () => {
    await context.log({ level: "info", message: `Entering Member ID: ${maskValue(memberId)}.`, rowIndex });
    await megaSearch.click();
    await page.waitForTimeout(250);
    await megaSearch.fill("");
    await page.waitForTimeout(200);
    await megaSearch.fill(memberId);
    await context.log({ level: "info", message: "TRACE 2: Member ID entered.", rowIndex });
    await page.waitForTimeout(kaiserConfig.timing.dropdownSettleMs);
  };

  await clearMegaSearchCriteria(page, memberId);
  await enterMemberId();

  for (let attempt = 1; attempt <= 2; attempt++) {
    await context.log({ level: "info", message: "Waiting for Additional Criteria dropdown.", rowIndex });
    if (await clickMegaSearchMemberIdOption(page, memberId, context, rowIndex)) {
      await context.log({ level: "info", message: "Selecting exact Member ID option.", rowIndex });
      await page.waitForTimeout(kaiserConfig.timing.postSelectionMs);
      await waitForDropdownClosed(page);
      const selectedCriterion = await getSelectedMegaSearchCriteria(page, memberId);
      if (selectedCriterion === "Member ID") {
        await context.log({ level: "info", message: "TRACE 3: Exact Member ID dropdown option selected.", rowIndex });
        const chipVisible = await hasSelectedMemberIdChip(page, memberId);
        await context.log({ level: "info", message: `Selected Member ID chip visible: ${chipVisible ? "yes" : "no"}.`, rowIndex });
        await context.log({ level: "info", message: "Member ID option selected successfully.", rowIndex });
        return true;
      }

      await context.log({
        level: "warn",
        message: selectedCriterion
          ? `Wrong Kaiser criterion selected: ${selectedCriterion}. Clearing and retrying Member ID.`
          : "Kaiser Member ID selection was not accepted. Retrying.",
        rowIndex,
      });
      await clearMegaSearchCriteria(page, memberId);
    }

    if (attempt === 1) {
      await context.log({ level: "warn", message: "Member ID option not found. Retrying dropdown once.", rowIndex });
      await page.waitForTimeout(kaiserConfig.timing.retryBackoffMs);
      await enterMemberId();
    }
  }

  await context.log({ level: "warn", message: "Member ID option not found.", rowIndex });
  return false;
}

async function fillDateAndCommit(page: Page, selector: string, value: string, label: string, context: ScraperContext, rowIndex: number): Promise<void> {
  const expected = normalizeDateValue(value);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const locator = await findVisibleLocator(page, selector, 3000);
    if (!locator) throw new Error(`Could not find Kaiser date field: ${selector}`);
    await context.log({ level: "info", message: `Filling Kaiser ${label} and pressing Enter: ${value}.`, rowIndex });
    await locator.click();
    await page.waitForTimeout(250);
    await locator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
    await page.waitForTimeout(150);
    await locator.fill(value);
    await context.log({
      level: "info",
      message: label === "From Date" ? "TRACE 4: From Date filled." : "TRACE 7: To Date filled.",
      rowIndex,
    });
    await page.waitForTimeout(350);
    await locator.press("Enter").catch(() => {});
    await context.log({
      level: "info",
      message: label === "From Date" ? "TRACE 5: From Date Enter pressed." : "TRACE 8: To Date Enter pressed.",
      rowIndex,
    });
    await page.waitForTimeout(350);
    await locator.evaluate((element) => (element as HTMLInputElement).blur()).catch(() => {});
    if (label === "From Date") {
      const nextLocator = await findVisibleLocator(page, kaiserConfig.selectors.toDate, 1000);
      await nextLocator?.click({ timeout: 1000 }).catch(() => {});
    } else {
      await page.mouse.click(20, 20).catch(() => {});
    }
    await page.waitForTimeout(700);
    const actual = await locator.inputValue({ timeout: 1000 }).catch(() => "");
    await context.log({
      level: "info",
      message: label === "From Date"
        ? `TRACE 6: From Date final value read back: ${actual || "(blank)"}.`
        : `TRACE 9: To Date final value read back: ${actual || "(blank)"}.`,
      rowIndex,
    });
    if (normalizeDateValue(actual) === expected) {
      await context.log({ level: "info", message: `Kaiser ${label} accepted: ${value}.`, rowIndex });
      return;
    }
    if (attempt === 1) {
      await context.log({ level: "warn", message: `Kaiser ${label} was not accepted. Retrying once.`, rowIndex });
      await page.waitForTimeout(kaiserConfig.timing.retryBackoffMs);
    }
  }

  throw new Error(`${label} was not accepted`);
}

type SearchSubmitState = "submitted" | "member-option-not-found" | "from-date-not-accepted" | "to-date-not-accepted";

async function getClaimTableSnapshot(page: Page): Promise<ClaimTableSnapshot> {
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const snapshot = await frame.evaluate(() => {
      function visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }
      function text(element: Element | null): string {
        return (element?.textContent || "").replace(/\s+/g, " ").trim();
      }

      const table = document.querySelector("#ClmTbl");
      if (!table) return { found: false, rowCount: 0, signature: "", rowTexts: [] };
      const rows = Array.from(table.querySelectorAll("tbody tr"))
        .filter((row) => visible(row))
        .map(text)
        .filter(Boolean);
      return {
        found: true,
        rowCount: rows.length,
        signature: rows.join("|"),
        rowTexts: rows,
      };
    }).catch(() => null);
    if (snapshot?.found) return snapshot;
  }
  return { found: false, rowCount: 0, signature: "", rowTexts: [] };
}

async function waitForKaiserLoadingToFinish(page: Page): Promise<void> {
  const selectors = [
    "iframe[src*='wait']",
    "iframe[name*='wait' i]",
    ".loading",
    ".ui-widget-overlay",
    ".ui-dialog:has-text('Loading')",
    "#wait",
    "#Wait",
    "[id*='loading' i]",
    "[class*='loading' i]",
    "[id*='wait' i]",
    "[class*='wait' i]",
  ].join(", ");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const active = await Promise.all(
      [page.mainFrame(), ...page.frames()].map((frame) =>
        frame.locator(selectors).evaluateAll((elements) =>
          elements.some((element) => {
            const style = window.getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          }),
        ).catch(() => false),
      ),
    );
    if (!active.some(Boolean)) return;
    await page.waitForTimeout(kaiserConfig.timing.stablePollMs);
  }
}

async function waitForClaimTableRefresh(page: Page, previousSignature: string, context: ScraperContext, rowIndex: number): Promise<ClaimTableSnapshot> {
  await context.log({ level: "info", message: "TRACE 10: Search request or table refresh started.", rowIndex });
  const deadline = Date.now() + 20000;
  let latest: ClaimTableSnapshot = { found: false, rowCount: 0, signature: "", rowTexts: [] };
  let stableReads = 0;

  while (Date.now() < deadline) {
    await waitForKaiserLoadingToFinish(page);
    latest = await getClaimTableSnapshot(page);
    if (latest.found) {
      await context.log({ level: "info", message: "TRACE 12: #ClmTbl found.", rowIndex });
      if (latest.signature && latest.signature !== previousSignature) {
        await context.log({ level: "info", message: "TRACE 11: Search request or table refresh completed.", rowIndex });
        return latest;
      }
      if (!latest.rowCount) stableReads += 1;
      if (stableReads >= 3) {
        await context.log({ level: "info", message: "TRACE 11: Search request or table refresh completed with empty table.", rowIndex });
        return latest;
      }
    }
    await page.waitForTimeout(kaiserConfig.timing.stablePollMs);
  }

  if (latest.found) {
    await context.log({ level: "warn", message: "Kaiser claim table refresh did not change before timeout; using the current #ClmTbl snapshot.", rowIndex });
    await context.log({ level: "info", message: "TRACE 11: Search request or table refresh completed.", rowIndex });
    return latest;
  }
  await context.log({ level: "warn", message: "Kaiser claim result table #ClmTbl was not found before timeout.", rowIndex });
  return latest;
}

async function submitSearch(page: Page, inputRow: KaiserInputRow, context: ScraperContext): Promise<SearchSubmitState> {
  const dates = dateRangeForDos(inputRow.dos);
  const previousSnapshot = await getClaimTableSnapshot(page);
  const selected = await selectMemberIdFromMegaSearch(page, inputRow.memberId, context, inputRow.inputRowId);
  if (!selected) return "member-option-not-found";
  try {
    await fillDateAndCommit(page, kaiserConfig.selectors.fromDate, dates.fromDate, "From Date", context, inputRow.inputRowId);
  } catch {
    return "from-date-not-accepted";
  }
  try {
    await fillDateAndCommit(page, kaiserConfig.selectors.toDate, dates.toDate, "To Date", context, inputRow.inputRowId);
  } catch {
    return "to-date-not-accepted";
  }
  await page.waitForTimeout(kaiserConfig.timing.preSearchMs);
  await waitForClaimTableRefresh(page, previousSnapshot.signature, context, inputRow.inputRowId);
  return "submitted";
}

async function extractSearchRows(page: Page, context: ScraperContext, rowIndex: number): Promise<ClaimSearchRow[]> {
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const rows = await frame.evaluate(() => {
      function text(element: Element | null): string {
        return (element?.textContent || "").replace(/\s+/g, " ").trim();
      }
      function visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
      }
      const table = document.querySelector("#ClmTbl");
      const output: ClaimSearchRow[] = [];
      if (!table) return output;

      const bodyRows = Array.from(table.querySelectorAll("tbody tr")).filter((tr) => visible(tr));
      const headers = [
        "Claim #",
        "Member ID",
        "Svc Frm Dt",
        "Vendor Tax ID",
        "Status",
        "Clm Rcv Dt",
        "Provider",
        "Vendor",
        "Member Name",
        "Provider NPI",
        "Net Payable",
        "Check #",
      ];
      for (const [index, tr] of bodyRows.entries()) {
        const cells = Array.from(tr.querySelectorAll("td")).map(text);
        if (!cells.some(Boolean)) continue;
        const mapped: Record<string, string> = {};
        headers.forEach((header, columnIndex) => {
          mapped[header] = cells[columnIndex] || "";
        });
        const claimNumber = mapped["Claim #"] || "";
        if (claimNumber) {
          output.push({
            claimNumber,
            cells: mapped,
            rowIndex: index,
            rowText: text(tr),
          });
        }
      }
      return output;
    }).catch(() => []);
    if (rows.length) {
      await context.log({ level: "info", message: `TRACE 13: Number of #ClmTbl tbody tr rows found: ${rows.length}.`, rowIndex });
      for (const row of rows) {
        await context.log({
          level: "info",
          message: `TRACE 14: Result row ${row.rowIndex + 1}: claim=${maskValue(row.claimNumber)}, svc_frm_dt="${getCell(row.cells, ["Svc Frm Dt"])}", member="${getCell(row.cells, ["Member Name"])}", status="${getCell(row.cells, ["Status"])}".`,
          rowIndex,
        });
      }
      return rows;
    }
  }
  await context.log({ level: "info", message: "TRACE 13: Number of #ClmTbl tbody tr rows found: 0.", rowIndex });
  return [];
}

async function findMatchingSearchRows(rows: ClaimSearchRow[], inputRow: KaiserInputRow, context: ScraperContext): Promise<ClaimSearchRow[]> {
  const expectedDos = normalizeDateValue(inputRow.dos);
  const expectedPatient = inputRow.patientName.trim();
  const dosCandidates: ClaimSearchRow[] = [];
  const patientMatches: ClaimSearchRow[] = [];

  for (const row of rows) {
    const rowDos = getCell(row.cells, ["Svc Frm Dt", "Service From Date", "DOS"]);
    const rowPatient = getCell(row.cells, ["Member Name", "Patient Name"]);
    const normalizedRowDos = normalizeDateValue(rowDos);
    const dosMatches = normalizedRowDos === expectedDos;
    const patientMatchesRow = Boolean(expectedPatient) && patientNamesMatch(rowPatient, expectedPatient);

    await context.log({
      level: "info",
      message: `TRACE 15: Patient Name and DOS comparison performed for claim ${maskValue(row.claimNumber)}: portal_patient="${rowPatient || "(blank)"}", portal_dos="${rowDos || "(blank)"}", expected_patient="${expectedPatient || "(blank)"}", expected_dos="${inputRow.dos}", dos_match=${dosMatches ? "yes" : "no"}, patient_match=${patientMatchesRow ? "yes" : "no"}.`,
      rowIndex: inputRow.inputRowId,
    });

    if (!dosMatches) continue;
    dosCandidates.push(row);
    if (expectedPatient && patientMatchesRow) patientMatches.push(row);
  }

  if (expectedPatient) return patientMatches;
  if (dosCandidates.length === 1) return dosCandidates;

  if (dosCandidates.length > 1) {
    await context.log({
      level: "warn",
      message: `Multiple Kaiser rows matched DOS ${inputRow.dos}, but Patient Name was blank. Refusing to guess.`,
      rowIndex: inputRow.inputRowId,
    });
  }
  return [];
}

async function waitForClaimDetailMarker(page: Page, context: ScraperContext, rowIndex: number): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const frame of [page.mainFrame(), ...page.frames()]) {
      const found = await frame.evaluate(() => {
        function text(element: Element | null): string {
          return (element?.textContent || "").replace(/\s+/g, " ").trim();
        }
        function visible(element: Element): boolean {
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        }

        // The search-results page's #ClmTbl header row literally contains the words
        // "Claim #" and "Status" as column headers, so a loose body-text/element-text
        // check can true-positive on the OLD page right after the click, before Kaiser
        // has actually finished navigating (or re-rendering in-frame) to the detail view.
        // Require an actual claim-number heading like "Claim #1194341053" (with digits)
        // AND confirm the search results table is gone before treating the detail page
        // as ready. This is what was causing "Claim details unavailable": extraction ran
        // against stale search-page DOM that has no Services/Payment/Adjudication sections.
        const hasClaimNumberHeading = Array.from(document.querySelectorAll("h1,h2,.sectionTitle"))
          .filter(visible)
          .some((element) => /Claim\s*#\s*\d+/i.test(text(element)));

        const searchTable = document.querySelector("#ClmTbl");
        const searchTableGone = !searchTable || !visible(searchTable);

        return hasClaimNumberHeading && searchTableGone;
      }).catch(() => false);
      if (found) {
        await context.log({ level: "info", message: "TRACE 19: Claim-detail page marker detected.", rowIndex });
        return;
      }
    }
    await page.waitForTimeout(kaiserConfig.timing.stablePollMs);
  }
  throw new Error("Kaiser claim-detail page marker was not detected.");
}

async function openClaimDetail(page: Page, resultRow: ClaimSearchRow, inputRow: KaiserInputRow, context: ScraperContext): Promise<void> {
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    const rows = frame.locator("#ClmTbl tbody tr").filter({ hasText: resultRow.claimNumber });
    const count = await rows.count().catch(() => 0);
    for (let index = 0; index < count; index++) {
      const row = rows.nth(index);
      const cells = row.locator("td");
      const firstCell = cells.nth(0);
      const claimText = cleanText(await firstCell.innerText({ timeout: 1000 }).catch(() => ""));
      const rowDos = cleanText(await cells.nth(2).innerText({ timeout: 1000 }).catch(() => ""));
      const rowPatient = cleanText(await cells.nth(8).innerText({ timeout: 1000 }).catch(() => ""));
      const sameClaim = claimText.includes(resultRow.claimNumber);
      const sameDos = normalizeDateValue(rowDos) === normalizeDateValue(inputRow.dos);
      const samePatient = !inputRow.patientName.trim() || patientNamesMatch(rowPatient, inputRow.patientName);
      if (!sameClaim || !sameDos || !samePatient) continue;

      const claimLink = firstCell.locator("a");
      const linkCount = await claimLink.count().catch(() => 0);
      if (linkCount !== 1) {
        throw new Error(`Expected one Claim # link inside matched Kaiser row, found ${linkCount}.`);
      }
      const linkText = cleanText(await claimLink.first().innerText({ timeout: 1000 }).catch(() => ""));
      if (!linkText) throw new Error("Matched Kaiser Claim # link text was empty.");
      await context.log({ level: "info", message: `TRACE 17: Claim # link found inside matched row: ${maskValue(linkText)}.`, rowIndex: inputRow.inputRowId });
      await Promise.all([
        page.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {}),
        claimLink.first().click(),
      ]);
      await context.log({ level: "info", message: "TRACE 18: Claim # clicked.", rowIndex: inputRow.inputRowId });
      await waitForClaimDetailMarker(page, context, inputRow.inputRowId);
      return;
    }
  }
  throw new Error(`Could not open Kaiser claim detail for ${resultRow.claimNumber}.`);
}

async function goBackToSearch(page: Page, context?: ScraperContext, rowIndex?: number): Promise<void> {
  if (page.isClosed()) return;
  if (await isSessionUnavailable(page)) return;
  if (await isClaimSearchReady(page, 500)) return;

  const selectors = [
    "#ToolBarbutton1",
    "[title='Back to Search List']",
    "#ToolBarbutton1 a.toolbarBottomText",
  ];
  for (const selector of selectors) {
    const backControl = await findVisibleLocator(page, selector, 2000);
    if (!backControl) continue;
    await backControl.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await backControl.click({ timeout: 5000 }).catch(async () => backControl.evaluate((element) => (element as HTMLElement).click()));
    const ready = await isClaimSearchReady(page, 15000);
    if (!ready) {
      await context?.log({ level: "warn", message: "Kaiser Back control clicked, but Claim Search fields were not confirmed ready.", rowIndex });
    }
    return;
  }
  await context?.log({ level: "warn", message: "Kaiser Back control was not found on claim-detail page.", rowIndex });
}

async function isClaimSearchReady(page: Page, timeout = 3000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  const selectors = ["#txtMegaSearch", "#txtFromDate", "#txtToDate"];
  while (Date.now() < deadline) {
    const ready = await Promise.all(selectors.map((selector) => findVisibleLocator(page, selector, 350)));
    if (ready.every(Boolean)) return true;
  }
  return false;
}

async function recoverKaiserSession(
  page: Page,
  input: Awaited<ReturnType<typeof parseKaiserInput>>,
  context: ScraperContext,
): Promise<boolean> {
  await context.log({ level: "warn", message: "Session expired during claim processing. Attempting approved login recovery." });
  try {
    if (await clickIfVisible(page, "a:has-text('Sign on again')", 1200)) {
      await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    }
    await login(page, input, context);
    await openClaimSearch(page, context);
    return true;
  } catch (error) {
    await context.log({ level: "error", message: `Kaiser session recovery failed: ${errorMessage(error)}` });
    return false;
  }
}

function emptyClaimDetails(claimNumber: string): ClaimDetails {
  return {
    claimNumber,
    status: "",
    checkEft: "",
    paymentDate: "",
    paymentAmount: "",
    claimCodeDescriptionTable: "",
    claimCodeDescriptions: {},
    claimLevelCodes: "",
    serviceLevelDescription: "",
    services: [],
  };
}

function hasRealClaimDetails(details: ClaimDetails): boolean {
  return details.services.length > 0
    || Boolean(details.status.trim())
    || Boolean(details.checkEft.trim())
    || Boolean(details.paymentDate.trim())
    || Boolean(details.paymentAmount.trim())
    || Boolean(details.claimLevelCodes.trim())
    || Boolean(details.serviceLevelDescription.trim());
}

function mergeClaimDetails(base: ClaimDetails, next: ClaimDetails): ClaimDetails {
  return {
    claimNumber: next.claimNumber || base.claimNumber,
    status: base.status || next.status,
    checkEft: base.checkEft || next.checkEft,
    paymentDate: base.paymentDate || next.paymentDate,
    paymentAmount: base.paymentAmount || next.paymentAmount,
    claimCodeDescriptionTable: base.claimCodeDescriptionTable || next.claimCodeDescriptionTable,
    claimCodeDescriptions: { ...next.claimCodeDescriptions, ...base.claimCodeDescriptions },
    claimLevelCodes: base.claimLevelCodes || next.claimLevelCodes,
    serviceLevelDescription: base.serviceLevelDescription || next.serviceLevelDescription,
    services: base.services.length >= next.services.length ? base.services : next.services,
  };
}

async function logClaimDetailDiagnostics(
  context: ScraperContext,
  rowIndex: number,
  details: ClaimDetailsExtraction,
): Promise<void> {
  await context.log({ level: "info", message: `Frames inspected: ${details.framesInspected}.`, rowIndex });
  await context.log({ level: "info", message: `Frame URL: ${details.frameUrls.join(" | ") || "(none)"}.`, rowIndex });
  await context.log({ level: "info", message: `Status found: ${details.status || "(none)"}.`, rowIndex });
  await context.log({ level: "info", message: `Services rows found: ${details.diagnostics.map((item) => item.servicesRowsFound).join(", ") || "0"}.`, rowIndex });
  await context.log({ level: "info", message: `Claim-Level found: ${details.claimLevelFound ? "yes" : "no"}.`, rowIndex });
  await context.log({ level: "info", message: `Service-Level found: ${details.serviceLevelFound ? "yes" : "no"}.`, rowIndex });
  await context.log({ level: "info", message: `Final merged Services rows: ${details.services.length}.`, rowIndex });
}

async function logEmptyServiceDiagnostics(
  context: ScraperContext,
  rowIndex: number,
  details: ClaimDetailsExtraction,
): Promise<void> {
  for (const diagnostic of details.diagnostics) {
    await context.log({
      level: "warn",
      message: [
        `Service extraction diagnostics for frame ${diagnostic.frameUrl || "(blank URL)"}`,
        `sectionText="${diagnostic.servicesSectionText.slice(0, 700) || "(none)"}"`,
        `tablesInsideServicesSection=${diagnostic.tablesInsideServicesSection}`,
        `headerRowsDetected=${JSON.stringify(diagnostic.headerRowsDetected)}`,
        `directCellRowsFound=${JSON.stringify(diagnostic.directCellRowsFound.slice(0, 8))}`,
      ].join("; "),
      rowIndex,
    });
  }
}

async function extractClaimDetails(
  page: Page,
  claimNumber: string,
  context: ScraperContext,
  rowIndex: number,
): Promise<ClaimDetailsExtraction> {
  const frames = Array.from(new Set([page.mainFrame(), ...page.frames()]));
  const frameUrls = frames.map((frame) => frame.url());
  let merged = emptyClaimDetails(claimNumber);
  let servicesSectionFound = false;
  let servicesTableFound = false;
  let claimLevelFound = false;
  let serviceLevelFound = false;
  const diagnostics: ClaimDetailsExtraction["diagnostics"] = [];

  for (const frame of frames) {
    const extracted = await frame.evaluate((args) => {
      function text(element: Element | null): string {
        return (element?.textContent || "").replace(/[\u00a0\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      }
      function normalizeHeader(value: string): string {
        return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
      }
      function visible(element: Element): boolean {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      }
      function directCells(row: Element): string[] {
        return Array.from((row as HTMLTableRowElement).cells || []).map(text);
      }
      function findSection(exactTitle: string): Element | null {
        return Array.from(document.querySelectorAll("h1,h2,.sectionTitle"))
          .filter(visible)
          .find((candidate) => text(candidate) === exactTitle)
          ?.closest(".pgSection") || null;
      }
      function findSectionByPattern(titlePattern: RegExp): Element | null {
        return Array.from(document.querySelectorAll("h1,h2,.sectionTitle"))
          .filter(visible)
          .find((candidate) => titlePattern.test(text(candidate)))
          ?.closest(".pgSection") || null;
      }
      function serviceTableResult(): {
        rows: string[][];
        sectionFound: boolean;
        tableFound: boolean;
        sectionText: string;
        tablesInsideSection: number;
        headerRowsDetected: string[][];
        directCellRowsFound: string[][];
      } {
        const expectedHeaders = new Set([
          "",
          "service",
          "from",
          "to",
          "modifiers",
          "quantity",
          "claimcodes",
          "billed",
          "allowed",
          "notcovered",
          "deductible",
          "coinsurance",
          "copay",
          "exceededbenefit",
          "patienttotal",
          "netpayable",
        ]);
        const servicesSection = findSection("Services");
        if (!servicesSection) {
          return {
            rows: [],
            sectionFound: false,
            tableFound: false,
            sectionText: "",
            tablesInsideSection: 0,
            headerRowsDetected: [],
            directCellRowsFound: [],
          };
        }
        const tables = Array.from(servicesSection.querySelectorAll("table")).filter(visible);
        const headerRowsDetected: string[][] = [];
        const directCellRowsFound: string[][] = [];
        for (const table of tables) {
          const rows = Array.from(table.querySelectorAll("tr"))
            .filter((tr) => tr.closest("table") === table)
            .filter(visible)
            .map(directCells)
            .filter((row) => row.some(Boolean));
          directCellRowsFound.push(...rows);
          const headerIndex = rows.findIndex((row) => {
            const headers = row.map(normalizeHeader);
            const headerHits = headers.filter((header) => expectedHeaders.has(header)).length;
            const isServicesHeader = headers.includes("service") && headers.includes("netpayable") && headerHits >= 10;
            if (isServicesHeader) headerRowsDetected.push(row);
            return isServicesHeader;
          });
          if (headerIndex < 0) continue;
          const resultRows = rows.slice(headerIndex).filter((row, index) => {
            if (index === 0) return true;
            const normalized = row.map(normalizeHeader);
            const repeatedHeader = normalized.includes("service") && normalized.includes("netpayable");
            const hasEnoughColumns = row.length >= 10;
            return hasEnoughColumns && row.some(Boolean) && !repeatedHeader;
          });
          if (resultRows.length > 1) {
            return {
              rows: resultRows,
              sectionFound: true,
              tableFound: true,
              sectionText: text(servicesSection),
              tablesInsideSection: tables.length,
              headerRowsDetected,
              directCellRowsFound,
            };
          }
        }
        return {
          rows: [],
          sectionFound: true,
          tableFound: headerRowsDetected.length > 0,
          sectionText: text(servicesSection),
          tablesInsideSection: tables.length,
          headerRowsDetected,
          directCellRowsFound,
        };
      }
      function sectionText(titlePattern: RegExp): string {
        return text(findSectionByPattern(titlePattern));
      }
      function firstDataRowAfterHeader(section: Element | null, requiredHeaders: string[]): string[] {
        if (!section) return [];
        for (const table of Array.from(section.querySelectorAll("table")).filter(visible)) {
          const rows = Array.from(table.querySelectorAll("tr"))
            .filter((tr) => tr.closest("table") === table)
            .filter(visible)
            .map(directCells)
            .filter((row) => row.some(Boolean));
          const headerIndex = rows.findIndex((row) => {
            const headers = row.map(normalizeHeader);
            return requiredHeaders.every((header) => headers.includes(normalizeHeader(header)));
          });
          if (headerIndex >= 0) return rows[headerIndex + 1] || [];
        }
        return [];
      }

      const bodyText = text(document.body);
      const statusMatch = bodyText.match(/Status\s+(Approved|Denied|Pending|In Process|Processed|Rejected)/i);
      const totalPaymentMatch = bodyText.match(/Total Payment:\s*\$?([0-9,.]+)/i);
      const paymentSection = findSection("Payment");
      const paymentRow = firstDataRowAfterHeader(paymentSection, ["Check/EFT", "Date", "Amount"]);
      const paymentCells = paymentRow.filter((value) => value.trim() && value !== "&nbsp;");

      const serviceResult = serviceTableResult();
      const serviceRows = serviceResult.rows;
      const serviceHeader = serviceRows[0] || [];
      const services = serviceRows.slice(1).map((row) => {
        const at = (name: string, fallbackIndex?: number) => {
          const normalizedName = normalizeHeader(name);
          const index = serviceHeader.findIndex((header) => normalizeHeader(header) === normalizedName);
          if (index >= 0) return row[index] || "";
          return fallbackIndex == null ? "" : row[fallbackIndex] || "";
        };
        return {
          number: at("#", 0) || row[0] || "",
          service: at("Service", 1) || row[1] || "",
          from: at("From"),
          to: at("To"),
          modifiers: at("Modifiers"),
          quantity: at("Quantity"),
          claimCodes: at("Claim Codes"),
          billed: at("Billed"),
          allowed: at("Allowed"),
          notCovered: at("Not Covered"),
          deductible: at("Deductible"),
          coinsurance: at("Coinsurance"),
          copay: at("Copay"),
          exceededBenefit: at("Exceeded Benefit"),
          patientTotal: at("Patient Total"),
          netPayable: at("Net Payable"),
        };
      }).filter((line) => line.service);

      const codeDescriptionRows = Array.from((findSection("Services") || document).querySelectorAll("table")).flatMap((table) => {
        const tableText = text(table);
        if (!/Claim Code Description Table/i.test(tableText)) return [];
        return Array.from(table.querySelectorAll("tr"))
          .filter((tr) => tr.closest("table") === table)
          .map((tr) => text(tr))
          .filter((value) => value && !/Claim Code Description Table/i.test(value));
      });
      const claimCodeDescriptions: Record<string, string> = {};
      for (const row of codeDescriptionRows) {
        const match = row.match(/^\[([^\]]+)\]\s*(.+)$/);
        if (match) {
          for (const code of match[1].split(/[,\s/]+/).map((value) => value.trim().toUpperCase()).filter(Boolean)) {
            claimCodeDescriptions[code] = match[2].trim();
          }
        }
      }
      const claimLevelText = sectionText(/Claim-Level/i).replace(/^Claim-Level\s*/i, "") || "";
      const serviceLevelText = sectionText(/Service-Level/i).replace(/^Service-Level\s*/i, "") || "";

      return {
        frameUrl: window.location.href,
        claimNumber: args.fallbackClaimNumber,
        status: statusMatch?.[1] || "",
        checkEft: paymentCells[0] || "",
        paymentDate: paymentCells[1] || "",
        paymentAmount: paymentCells[2] || (totalPaymentMatch?.[1] ? `$${totalPaymentMatch[1]}` : ""),
        claimCodeDescriptionTable: codeDescriptionRows.join("\n"),
        claimCodeDescriptions,
        claimLevelCodes: claimLevelText,
        serviceLevelDescription: serviceLevelText,
        services,
        servicesSectionFound: serviceResult.sectionFound,
        servicesTableFound: serviceResult.tableFound,
        claimLevelFound: Boolean(claimLevelText.trim()),
        serviceLevelFound: Boolean(serviceLevelText.trim()),
        diagnostics: {
          frameUrl: window.location.href,
          servicesSectionFound: serviceResult.sectionFound,
          servicesTableFound: serviceResult.tableFound,
          servicesRowsFound: services.length,
          servicesSectionText: serviceResult.sectionText,
          tablesInsideServicesSection: serviceResult.tablesInsideSection,
          headerRowsDetected: serviceResult.headerRowsDetected,
          directCellRowsFound: serviceResult.directCellRowsFound,
        },
      };
    }, { fallbackClaimNumber: claimNumber }).catch(() => null);

    if (!extracted) continue;
    servicesSectionFound = servicesSectionFound || extracted.servicesSectionFound;
    servicesTableFound = servicesTableFound || extracted.servicesTableFound;
    claimLevelFound = claimLevelFound || extracted.claimLevelFound;
    serviceLevelFound = serviceLevelFound || extracted.serviceLevelFound;
    diagnostics.push(extracted.diagnostics);
    const frameDetails: ClaimDetails = {
      claimNumber: extracted.claimNumber,
      status: extracted.status,
      checkEft: extracted.checkEft,
      paymentDate: extracted.paymentDate,
      paymentAmount: extracted.paymentAmount,
      claimCodeDescriptionTable: extracted.claimCodeDescriptionTable,
      claimCodeDescriptions: extracted.claimCodeDescriptions,
      claimLevelCodes: extracted.claimLevelCodes,
      serviceLevelDescription: extracted.serviceLevelDescription,
      services: extracted.services,
    };
    if (hasRealClaimDetails(frameDetails)) merged = mergeClaimDetails(merged, frameDetails);
  }

  const finalDetails: ClaimDetailsExtraction = {
    ...merged,
    framesInspected: frames.length,
    frameUrls,
    servicesSectionFound,
    servicesTableFound,
    claimLevelFound,
    serviceLevelFound,
    diagnostics,
  };
  await logClaimDetailDiagnostics(context, rowIndex, finalDetails);
  if (hasRealClaimDetails(finalDetails)) return finalDetails;
  throw new Error("Could not extract Kaiser claim detail fields.");
}

async function findMatchingService(
  details: ClaimDetails,
  cptCode: string,
  context: ScraperContext,
  rowIndex: number,
): Promise<ServiceLine | null> {
  const normalizedCpt = normalizeCptCode(cptCode);
  await context.log({ level: "info", message: `Excel CPT normalized: ${normalizedCpt}.`, rowIndex });
  await context.log({ level: "info", message: `Services rows found: ${details.services.length}.`, rowIndex });
  for (const [index, service] of details.services.entries()) {
    const portalCpt = serviceCodeFromText(service.service);
    await context.log({ level: "info", message: `Service row ${index + 1} raw Service: ${service.service}.`, rowIndex });
    await context.log({ level: "info", message: `Service row ${index + 1} CPT extracted: ${portalCpt}.`, rowIndex });
    await context.log({ level: "info", message: `Comparing Excel CPT ${normalizedCpt} with portal CPT ${portalCpt}.`, rowIndex });
    if (portalCpt === normalizedCpt) {
      await context.log({ level: "info", message: `Matching CPT found at service row ${index + 1}.`, rowIndex });
      return service;
    }
  }
  await context.log({ level: "warn", message: "CPT not found after checking all service rows.", rowIndex });
  return null;
}

async function processRow(page: Page, inputRow: KaiserInputRow, state: KaiserWorkbookState, context: ScraperContext): Promise<void> {
  if (inputRow.validationStatus !== "valid") {
    const status = !inputRow.memberId ? "Missing Member ID" : inputRow.validationMessage === "Invalid DOS" ? "Invalid DOS" : "Invalid Row";
    state.outputRows.push(baseOutputRow(inputRow, status, inputRow.validationMessage));
    addAudit(state, inputRow, "validation", "failed", inputRow.validationMessage);
    return;
  }

  await context.log({ level: "info", message: `Kaiser row ${inputRow.inputRowId}: searching Member ID ${inputRow.memberId}, DOS ${inputRow.dos}.`, rowIndex: inputRow.inputRowId });
  addAudit(state, inputRow, "search", "started", "Submitting Kaiser claim search.");
  const searchState = await submitSearch(page, inputRow, context);
  if (searchState === "member-option-not-found") {
    state.outputRows.push(baseOutputRow(inputRow, "Member ID option not found", "Member ID option not found"));
    addAudit(state, inputRow, "search", "failed", "Member ID option not found");
    return;
  }
  if (searchState === "from-date-not-accepted") {
    state.outputRows.push(baseOutputRow(inputRow, "From Date was not accepted", "From Date was not accepted"));
    addAudit(state, inputRow, "search", "failed", "From Date was not accepted");
    return;
  }
  if (searchState === "to-date-not-accepted") {
    state.outputRows.push(baseOutputRow(inputRow, "To Date was not accepted", "To Date was not accepted"));
    addAudit(state, inputRow, "search", "failed", "To Date was not accepted");
    return;
  }
  await context.log({ level: "info", message: "Reading Kaiser claim search results.", rowIndex: inputRow.inputRowId });
  const searchRows = await extractSearchRows(page, context, inputRow.inputRowId);

  if (!searchRows.length) {
    const pageText = await page.locator("body").innerText({ timeout: 2000 }).catch(() => "");
    const status = /member not found|no member/i.test(pageText) ? "Member Not Found" : "No claims found";
    await context.log({ level: "info", message: `Kaiser row ${inputRow.inputRowId}: ${status}.`, rowIndex: inputRow.inputRowId });
    state.outputRows.push(baseOutputRow(inputRow, status, status));
    addAudit(state, inputRow, "search", "completed", status);
    return;
  }

  await context.log({ level: "info", message: `Kaiser row ${inputRow.inputRowId}: found ${searchRows.length} claim result(s).`, rowIndex: inputRow.inputRowId });
  await context.log({ level: "info", message: `Number of claim rows found: ${searchRows.length}.`, rowIndex: inputRow.inputRowId });
  const matchedRows = await findMatchingSearchRows(searchRows, inputRow, context);
  if (!matchedRows.length) {
    await context.log({ level: "warn", message: "No matching patient/DOS row.", rowIndex: inputRow.inputRowId });
    state.outputRows.push(baseOutputRow(inputRow, "No claim row matched Patient Name and DOS", "No claim row matched Patient Name and DOS"));
    addAudit(state, inputRow, "search", "completed", "No claim row matched Patient Name and DOS");
    return;
  }
  if (matchedRows.length > 1) {
    await context.log({
      level: "warn",
      message: `Multiple matching claim rows found: ${matchedRows.map((row) => row.claimNumber).join(", ")}. Checking each matched claim for CPT.`,
      rowIndex: inputRow.inputRowId,
    });
  }

  for (const resultRow of matchedRows) {
    await context.log({ level: "info", message: `TRACE 16: Matching row selected: ${maskValue(resultRow.claimNumber)}.`, rowIndex: inputRow.inputRowId });
    await context.log({ level: "info", message: `Matching claim row found: ${resultRow.claimNumber}.`, rowIndex: inputRow.inputRowId });
    await context.log({ level: "info", message: `Clicking Claim # ${maskValue(resultRow.claimNumber)}.`, rowIndex: inputRow.inputRowId });
    let detailPageOpened = false;
    let detailProcessingResult = "Claim details unavailable";
    try {
      await openClaimDetail(page, resultRow, inputRow, context);
      detailPageOpened = true;
      await context.log({ level: "info", message: "Claim-detail page loaded.", rowIndex: inputRow.inputRowId });
      await context.log({ level: "info", message: `Extracting Kaiser claim ${resultRow.claimNumber}.`, rowIndex: inputRow.inputRowId });
      const details = await extractClaimDetails(page, resultRow.claimNumber, context, inputRow.inputRowId);
      await context.log({ level: "info", message: `Excel CPT raw: ${inputRow.cptCodeRaw || inputRow.cptCode}.`, rowIndex: inputRow.inputRowId });
      await context.log({ level: "info", message: `Services section found: ${details.servicesSectionFound ? "yes" : "no"}.`, rowIndex: inputRow.inputRowId });
      await context.log({ level: "info", message: `Services table found: ${details.servicesTableFound ? "yes" : "no"}.`, rowIndex: inputRow.inputRowId });
      await context.log({ level: "info", message: `Services rows extracted: ${details.services.length}.`, rowIndex: inputRow.inputRowId });
      await context.log({ level: "info", message: `TRACE 20: Services rows extracted: ${details.services.length}.`, rowIndex: inputRow.inputRowId });
      await context.log({ level: "info", message: `TRACE 21: Excel CPT compared against Services rows: ${inputRow.cptCode}.`, rowIndex: inputRow.inputRowId });
      if (!details.servicesSectionFound) {
        detailProcessingResult = "Services section not found";
        await logEmptyServiceDiagnostics(context, inputRow.inputRowId, details);
        await captureDiagnostics(context, page, inputRow, "services-section-not-found");
        state.outputRows.push(baseOutputRow(inputRow, "Services section not found", "Services section not found"));
        addAudit(state, inputRow, "detail", "failed", "Services section not found");
        return;
      }
      if (!details.services.length) {
        detailProcessingResult = "Services rows could not be extracted";
        await logEmptyServiceDiagnostics(context, inputRow.inputRowId, details);
        await captureDiagnostics(context, page, inputRow, "services-rows-not-extracted");
        state.outputRows.push(baseOutputRow(inputRow, "Services rows could not be extracted", "Services rows could not be extracted"));
        addAudit(state, inputRow, "detail", "failed", "Services rows could not be extracted");
        return;
      }
      const matchingService = await findMatchingService(details, inputRow.cptCode, context, inputRow.inputRowId);
      if (matchingService) {
        const denialDescription = serviceSpecificDenial(details, matchingService);
        await context.log({ level: "info", message: `Matching service row found: ${matchingService.service}.`, rowIndex: inputRow.inputRowId });
        await context.log({ level: "info", message: `Matching service Net Payable: ${matchingService.netPayable || "0.00"}.`, rowIndex: inputRow.inputRowId });
        await context.log({ level: "info", message: `Matching service claim codes: ${matchingService.claimCodes || "(none)"}.`, rowIndex: inputRow.inputRowId });
        await context.log({ level: "info", message: `Matching service denial description: ${denialDescription.text || "(none)"}.`, rowIndex: inputRow.inputRowId });
        await context.log({ level: "info", message: `Matching service denial source: ${denialDescription.source || "(none)"}.`, rowIndex: inputRow.inputRowId });
        await context.log({ level: "info", message: "TRACE 22: Matching service extracted.", rowIndex: inputRow.inputRowId });
        state.outputRows.push(outputRowFromClaim(inputRow, details, matchingService));
        addAudit(state, inputRow, "detail", "completed", `Matched claim ${resultRow.claimNumber} and CPT ${inputRow.cptCode}.`);
        detailProcessingResult = "Success";
        return;
      }
      detailProcessingResult = "CPT not found in Services";
      await context.log({ level: "warn", message: `No matching CPT service row in claim ${resultRow.claimNumber}.`, rowIndex: inputRow.inputRowId });
    } catch (error) {
      detailProcessingResult = "Claim details unavailable";
      await context.log({ level: "error", message: `Claim details unavailable: ${errorMessage(error)}`, rowIndex: inputRow.inputRowId });
      state.outputRows.push(baseOutputRow(inputRow, "Claim details unavailable", "Claim details unavailable"));
      addAudit(state, inputRow, "detail", "failed", "Claim details unavailable");
      return;
    } finally {
      if (detailPageOpened && !context.isCancelled?.()) {
        await context.log({ level: "info", message: `Detail processing result: ${detailProcessingResult}.`, rowIndex: inputRow.inputRowId });
        await goBackToSearch(page, context, inputRow.inputRowId);
      }
    }
  }

  state.outputRows.push(baseOutputRow(inputRow, "CPT not found in Services", `CPT not found in Services: ${inputRow.cptCode}.`));
  addAudit(state, inputRow, "detail", "completed", `No service matched CPT ${inputRow.cptCode}.`);
}

async function emitArtifacts(context: ScraperContext, state: KaiserWorkbookState): Promise<void> {
  const workbookBuffer = await createKaiserOutputWorkbookBuffer(state);
  await context.emit({
    type: "file_download",
    filename: "kaiser_output.xlsx",
    base64: workbookBuffer.toString("base64"),
    mimeType: OUTPUT_MIME,
  });
  const logContent = state.auditRows.map((row) => `[${row.timestamp}] row=${row.inputRowId} ${row.step} ${row.status}: ${row.message}`).join("\n");
  await context.emit({
    type: "file_download",
    filename: "kaiser-run.log",
    base64: Buffer.from(logContent, "utf8").toString("base64"),
    mimeType: "text/plain",
  });
}

export async function runKaiserClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parseKaiserInput(formData);
  const rows = readKaiserInputWorkbook(input.inputWorkbookBuffer);
  const state: KaiserWorkbookState = { outputRows: [], auditRows: [] };
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    await context.log({ level: "info", message: `Kaiser input loaded: ${rows.length} row(s).` });
    await context.emit({ type: "progress", completed: 0, total: rows.length });
    browser = await launchKaiserBrowser((message) => context.log({ level: "info", message }));
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });

    await login(page, input, context);
    await openClaimSearch(page, context);

    let completed = 0;
    for (const row of rows) {
      if (context.isCancelled?.()) {
        await context.log({ level: "warn", message: "Kaiser run stopped by user. Creating partial output." });
        await context.emit({ type: "cancelled", message: "Kaiser scraping stopped. Partial workbook downloaded." });
        break;
      }

      try {
        if (await isSessionUnavailable(page)) {
          await context.log({ level: "warn", message: "Kaiser session is unavailable before row processing. Retrying current row after session recovery.", rowIndex: row.inputRowId });
          if (!(await recoverKaiserSession(page, input, context))) {
            state.outputRows.push(baseOutputRow(row, "Portal session unavailable", "Portal session unavailable"));
            addAudit(state, row, "session", "failed", "Portal session unavailable");
            completed += 1;
            await context.emit({ type: "progress", completed, total: rows.length });
            continue;
          }
        }

        try {
          await processRow(page, row, state, context);
        } catch (error) {
          if (!(await isSessionUnavailable(page))) {
            throw error;
          }

          await context.log({ level: "warn", message: "Session expired during claim processing. Retrying current row after session recovery.", rowIndex: row.inputRowId });
          if (!(await recoverKaiserSession(page, input, context))) {
            state.outputRows.push(baseOutputRow(row, "Session expired", "Session expired"));
            addAudit(state, row, "session", "failed", "Session expired");
          } else {
            await processRow(page, row, state, context);
          }
        }
      } catch (error) {
        const message = errorMessage(error);
        addAudit(state, row, "row_processing", "failed", message);
        state.outputRows.push(baseOutputRow(row, "Portal Error", message));
        if (page) await captureDiagnostics(context, page, row, "row-error");
      }

      completed += 1;
      await context.emit({ type: "progress", completed, total: rows.length });
      await context.log({ level: "info", message: "Applying controlled delay before next row.", rowIndex: row.inputRowId });
      await page.waitForTimeout(kaiserConfig.timing.betweenRowsMs);
    }

    await emitArtifacts(context, state);
    await context.emit({ type: "done" });
  } catch (error) {
    const message = errorMessage(error);
    addAudit(state, null, "job", "failed", message);
    await context.log({ level: "error", message: `Kaiser run failed: ${message}` });
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