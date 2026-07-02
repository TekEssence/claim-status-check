import type { Page } from "playwright-core";
import { blueShieldConfig } from "./config";
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

async function fillSearchCriteria(page: Page, workItem: BlueShieldMemberWorkItem, dosRange: { start: string; end: string }): Promise<boolean> {
  const selectors = blueShieldConfig.selectors;
  const memberId = normalizeMemberId(workItem.memberId);

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

export async function navigateToBlueShieldClaimStatus(page: Page, credentials: BlueShieldCredentials): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.goto(credentials.claimStatusUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator(blueShieldConfig.selectors.memberIdInput).first().waitFor({ state: "visible", timeout: 12000 }).catch(() => {});
  await assertNoSecurityBlock(page);

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
    await page.locator(blueShieldConfig.selectors.resultRows).first().waitFor({ state: "visible", timeout: 15000 }).catch(() => {});
    await assertNoSecurityBlock(page);

    if (await visibleCount(page, blueShieldConfig.selectors.resultRows) > 0) {
      return { dosSearched: lastSearchDisplay };
    }
  }

  await log(`Blue Shield member ${memberId}: no claim rows found after expanding DOS search through ${lastSearchDisplay}.`);
  return { dosSearched: lastSearchDisplay };
}

export const blueShieldClaimStatusTestHooks = {
  expandDosRange,
};
