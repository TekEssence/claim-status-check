import type { Locator, Page } from "playwright-core";
import { blueShieldConfig } from "./config";
import { isBlueShieldPingAuthorizationUrl } from "./auth-state";
import { assertNoSecurityBlock } from "./detection-monitor";
import type { BlueShieldCredentials, BlueShieldMemberWorkItem } from "./types";

const BLUE_SHIELD_DOS_FALLBACK_EXPANSION_DAYS = 7;

function parseDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value);
  next.setDate(next.getDate() + days);
  return next;
}

function formatDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${month}/${day}/${value.getFullYear()}`;
}

function normalizeMemberId(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function getDosRange(dosValues: string[]): { start: string; end: string; display: string } {
  const dates = dosValues.map(parseDate).filter((date): date is Date => Boolean(date));
  if (!dates.length) {
    const fallback = dosValues[0] ?? "";
    return { start: fallback, end: fallback, display: dosValues.join(", ") };
  }
  const times = dates.map((date) => date.getTime());
  return {
    start: formatDate(new Date(Math.min(...times))),
    end: formatDate(new Date(Math.max(...times))),
    display: dosValues.join(", "),
  };
}

function expandDosRange(
  dosRange: { start: string; end: string; display: string },
  expansionDays: number,
): { start: string; end: string; display: string } {
  if (expansionDays <= 0) return dosRange;

  const startDate = parseDate(dosRange.start);
  const endDate = parseDate(dosRange.end);
  if (!startDate || !endDate) return dosRange;

  return {
    start: formatDate(addDays(startDate, -expansionDays)),
    end: formatDate(addDays(endDate, expansionDays)),
    display: `${dosRange.display} expanded +/- ${expansionDays} day(s)`,
  };
}

async function fillFirstAvailable(page: Page, selector: string, value: string): Promise<boolean> {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return false;
  if (!await locator.isVisible().catch(() => false)) return false;
  await locator.fill(value);
  return true;
}

async function clearVisibleInputs(locator: Locator): Promise<number> {
  const count = await locator.count().catch(() => 0);
  let cleared = 0;
  for (let index = 0; index < count; index++) {
    const input = locator.nth(index);
    if (!await input.isVisible().catch(() => false)) continue;
    await input.fill("").catch(async () => {
      await input.evaluate((element) => {
        if (!(element instanceof HTMLInputElement)) return;
        const prototype = Object.getPrototypeOf(element) as HTMLInputElement;
        const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
        descriptor?.set?.call(element, "");
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      }).catch(() => {});
    });
    cleared++;
  }
  return cleared;
}

async function clearClaimOrEobSearchFields(page: Page): Promise<void> {
  const selectors = blueShieldConfig.selectors;
  await page.evaluate(() => {
    const visible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const setNativeValue = (element: HTMLInputElement | HTMLSelectElement, value: string) => {
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      descriptor?.set?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    };

    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("input"))) {
      const type = (input.getAttribute("type") || "text").toLowerCase();
      if (!visible(input) || input.disabled || input.readOnly || ["button", "submit", "reset", "checkbox", "radio", "hidden"].includes(type)) continue;
      setNativeValue(input, "");
    }
    for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>("select"))) {
      if (!visible(select) || select.disabled) continue;
      setNativeValue(select, "");
    }
  }).catch(() => {});

  await clearVisibleInputs(page.locator(selectors.claimEobInput));
  await clearVisibleInputs(page.locator(selectors.checkEftInput));

  await page.evaluate(() => {
    const visible = (element: HTMLElement) => {
      const style = window.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
    };
    const isClaimOrEobSearchField = (element: HTMLInputElement) => {
      const attributes = [
        element.id,
        element.name,
        element.placeholder,
        element.ariaLabel,
        element.getAttribute("formcontrolname"),
        element.getAttribute("data-testid"),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!/(claim|eob)/i.test(attributes)) return false;
      return !/(claimsearchstatus|status|fromdate|todate|memid|member|subscriber)/i.test(attributes);
    };

    for (const input of Array.from(document.querySelectorAll<HTMLInputElement>("input"))) {
      if (!visible(input) || input.disabled || input.readOnly || !isClaimOrEobSearchField(input)) continue;
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }).catch(() => {});
}

async function resetBlueShieldSearchForm(page: Page): Promise<void> {
  const startOver = page.locator(blueShieldConfig.selectors.startOverSearch).first();
  if (await startOver.isVisible({ timeout: 1000 }).catch(() => false)) {
    await startOver.click({ timeout: 3000 }).catch(async () => {
      await startOver.click({ force: true, timeout: 3000 });
    });
    await page.waitForTimeout(500);
  }
  await clearClaimOrEobSearchFields(page);
}

async function fillSearchCriteria(page: Page, workItem: BlueShieldMemberWorkItem, dosRange: { start: string; end: string }): Promise<boolean> {
  const selectors = blueShieldConfig.selectors;
  const memberId = normalizeMemberId(workItem.memberId);

  await resetBlueShieldSearchForm(page);

  if (!await fillFirstAvailable(page, selectors.memberIdInput, memberId)) {
    throw new Error("Blue Shield Member ID input was not found.");
  }

  const filledRange =
    await fillFirstAvailable(page, selectors.dosStartInput, dosRange.start) &&
    await fillFirstAvailable(page, selectors.dosEndInput, dosRange.end);
  if (!filledRange) {
    await fillFirstAvailable(page, selectors.dosInput, dosRange.start);
  }

  return filledRange;
}

async function visibleCount(page: Page, selector: string): Promise<number> {
  return page.locator(selector).count().catch(() => 0);
}

async function visibleClaimResultCount(page: Page, memberId: string): Promise<number> {
  const pageText = await page.locator("body").innerText({ timeout: 3000 }).catch(() => "");
  if (/showing\s+0\s+claims/i.test(pageText) || /couldn[’']?t\s+find\s+any\s+claims\s+that\s+match\s+your\s+search/i.test(pageText)) {
    return 0;
  }

  const normalizedMemberId = normalizeMemberId(memberId).toLowerCase();
  const rows = page.locator(blueShieldConfig.selectors.resultRows);
  const rowCount = await rows.count().catch(() => 0);
  let resultCount = 0;

  for (let index = 0; index < rowCount; index++) {
    const row = rows.nth(index);
    if (!await row.isVisible().catch(() => false)) continue;
    const text = (await row.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (!text) continue;

    const normalizedText = text.replace(/\s+/g, "").toLowerCase();
    const hasDate = /\b\d{1,2}\/\d{1,2}\/(?:\d{2}|\d{4})\b/.test(text);
    const hasMember = normalizedMemberId && normalizedText.includes(normalizedMemberId);
    const hasClaimSignal = /\b(claim|eob|paid|pending|denied|billed|patient responsibility)\b/i.test(text) || /\$[0-9,]+(?:\.\d{2})?/.test(text);
    const cellCount = await row.locator("td").count().catch(() => 0);
    if (cellCount >= 4 && hasDate && (hasMember || hasClaimSignal)) {
      resultCount++;
    }
  }

  return resultCount;
}

export async function navigateToBlueShieldClaimStatus(page: Page, credentials: BlueShieldCredentials): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.goto(credentials.claimStatusUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(blueShieldConfig.selectors.memberIdInput).first().waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
  await assertNoSecurityBlock(page);

  if (isBlueShieldPingAuthorizationUrl(page.url())) {
    throw new Error(`Blue Shield session expired and redirected to Ping authorization. Current URL: ${page.url()}`);
  }

  if (await visibleCount(page, blueShieldConfig.selectors.memberIdInput) > 0) {
    return;
  }

  const selectors = blueShieldConfig.selectors;
  const hamburger = page.locator(selectors.hamburgerMenu).first();
  if (await hamburger.isVisible().catch(() => false)) {
    await hamburger.click();
    await page.waitForTimeout(500);
  }

  const claimsMenu = page.locator(selectors.claimsMenu).first().locator("xpath=ancestor-or-self::*[self::a or self::button or @role='button'][1]");
  if (await claimsMenu.isVisible().catch(() => false)) {
    await claimsMenu.hover().catch(() => {});
    await page.waitForTimeout(500);
    await claimsMenu.click();
    await page.waitForTimeout(1000);
  }

  const claimStatusLink = page.locator(selectors.checkClaimStatus).first();
  await claimStatusLink.waitFor({ state: "visible", timeout: 5000 }).catch(() => {});
  if (await claimStatusLink.isVisible().catch(() => false)) {
    await claimStatusLink.click();
    await page.locator(blueShieldConfig.selectors.memberIdInput).first().waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
    await assertNoSecurityBlock(page);
  }

  if (await visibleCount(page, blueShieldConfig.selectors.memberIdInput) === 0) {
    throw new Error(`Blue Shield claim status page was not reached. Current URL: ${page.url()}`);
  }
}

export async function searchBlueShieldClaims(options: {
  page: Page;
  workItem: BlueShieldMemberWorkItem;
  log: (message: string) => Promise<void>;
}): Promise<{ dosSearched: string }> {
  const { page, workItem, log } = options;
  const selectors = blueShieldConfig.selectors;
  const dosRange = getDosRange(workItem.dosValues);
  const memberId = normalizeMemberId(workItem.memberId);
  let lastSearchDisplay = dosRange.start;

  for (let expansionDays = 0; expansionDays <= BLUE_SHIELD_DOS_FALLBACK_EXPANSION_DAYS; expansionDays++) {
    const currentRange = expandDosRange(dosRange, expansionDays);
    await log(
      expansionDays === 0
        ? `Searching Blue Shield member ${memberId} for DOS ${currentRange.display}.`
        : `Blue Shield member ${memberId}: no results for exact DOS. Retrying DOS ${currentRange.start} - ${currentRange.end}.`,
    );

    const filledRange = await fillSearchCriteria(page, workItem, currentRange);
    lastSearchDisplay = filledRange ? `${currentRange.start} - ${currentRange.end}` : currentRange.start;

    await page.locator(selectors.searchSubmit).first().click();
    await page.locator(blueShieldConfig.selectors.resultRows).first().waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
    await assertNoSecurityBlock(page);

    if (await visibleClaimResultCount(page, memberId) > 0) {
      return { dosSearched: lastSearchDisplay };
    }
  }

  await log(`Blue Shield member ${memberId}: no claim rows found after expanding DOS search through ${lastSearchDisplay}.`);
  return { dosSearched: lastSearchDisplay };
}

export const blueShieldClaimStatusTestHooks = {
  expandDosRange,
};
