import type { Download, Page } from "playwright-core";

type LogFn = (message: string) => Promise<void>;

const FINANCE_TOGGLE_SELECTOR = "a[ng-click*='vm.toggle.FIN']";
const COVERED_RA_LINK_SELECTOR = "a[ui-sref='finance.covered']";
const SEARCH_INPUT_SELECTOR = "input#search, input[placeholder*='Check Number']";
const RESET_SEARCH_SELECTOR = "div[uib-popover='Reset search'], .close-btn[uib-popover*='Reset search']";
const SEARCH_BUTTON_SELECTOR = ".singleSearchButton, button[type='submit']";
const RESULT_ROW_SELECTOR = "tr.line-item";
const DOWNLOAD_ICON_SELECTOR = ".fa-arrow-circle-down";

export function extractCheckNumbersFromClaimDetailText(text: string): string[] {
  const matches = Array.from(
    text.matchAll(/Check\s*(?:#|No\.?|Number)\s*:?\s*([A-Z0-9-]{5,20})/gi),
    (match) => match[1].trim(),
  );

  return Array.from(new Set(matches.filter(Boolean)));
}

async function waitForResultsToSettle(page: Page): Promise<void> {
  await page.locator("div[full-screen-ajax-loader] .full-screen-bg").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

export async function navigateToCoveredRaPage(page: Page, log: LogFn): Promise<void> {
  await log("Opening Finance tab...");
  const financeToggle = page.locator(FINANCE_TOGGLE_SELECTOR).first();
  await financeToggle.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error("Finance tab was not found on the IEHP site.");
  });
  await financeToggle.click({ force: true });
  await page.waitForTimeout(750);

  await log("Opening IEHP Covered RAs...");
  const coveredRaLink = page.locator(COVERED_RA_LINK_SELECTOR).first();
  await coveredRaLink.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error("IEHP Covered RAs link was not found under the Finance tab.");
  });
  await coveredRaLink.click({ force: true });
  await waitForResultsToSettle(page);

  const searchInput = page.locator(SEARCH_INPUT_SELECTOR).first();
  await searchInput.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error("Check Number search input was not found on the IEHP Covered RAs page.");
  });
}

export async function searchCoveredRaByCheckNumber(page: Page, checkNumber: string, log: LogFn): Promise<void> {
  await log(`Searching IEHP Covered RAs for Check Number ${checkNumber}...`);

  const resetSearch = page.locator(RESET_SEARCH_SELECTOR).first();
  if (await resetSearch.count() > 0 && await resetSearch.isVisible().catch(() => false)) {
    await resetSearch.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }

  const searchInput = page.locator(SEARCH_INPUT_SELECTOR).first();
  await searchInput.fill(checkNumber);
  await page.waitForTimeout(300);

  const searchButton = page.locator(SEARCH_BUTTON_SELECTOR).first();
  if (await searchButton.count() > 0 && await searchButton.isVisible().catch(() => false)) {
    await searchButton.click({ force: true });
  } else {
    await searchInput.press("Enter");
  }

  await waitForResultsToSettle(page);

  const rowCheckCell = page.locator(`${RESULT_ROW_SELECTOR} td`).filter({ hasText: checkNumber }).first();
  if (await rowCheckCell.count() === 0 || !(await rowCheckCell.isVisible().catch(() => false))) {
    throw new Error(`No IEHP Covered RA row was found for Check Number ${checkNumber}.`);
  }
}

export async function downloadCoveredRaPdf(page: Page, checkNumber: string, log: LogFn): Promise<Download> {
  await log(`Downloading PDF for Check Number ${checkNumber} from IEHP Covered RAs...`);

  const matchingRow = page.locator(RESULT_ROW_SELECTOR).filter({
    has: page.locator("td", { hasText: checkNumber }),
  }).first();

  await matchingRow.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error(`Result row for Check Number ${checkNumber} was not visible in IEHP Covered RAs.`);
  });

  const downloadIcon = matchingRow.locator(DOWNLOAD_ICON_SELECTOR).first();
  await downloadIcon.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error(`Download button was not found for Check Number ${checkNumber}.`);
  });

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 25000 }),
    downloadIcon.click({ force: true }),
  ]).then(([event]) => event).catch(() => {
    throw new Error(`PDF download did not start for Check Number ${checkNumber}.`);
  });

  return download;
}
