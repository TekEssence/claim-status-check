import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Download, Page } from "playwright-core";
import { formatMmDdYyyy } from "@/lib/claim-dates";
import { extractTextPagesFromPdf, rotatePdfBufferCounterClockwise } from "@/lib/claim-pdf";
import { describeRaMatchFailureFromPdfPages, parseRaDetailsFromPdfPages, type RaDetailRecord } from "@/lib/claim-ra";

type LogFn = (message: string) => Promise<void>;
type StreamEvent = Record<string, unknown>;
type RotationCandidate = 0 | 90 | 180 | 270;

const FINANCE_TOGGLE_SELECTOR = "a[ng-click*='vm.toggle.FIN']";
const COVERED_RA_LINK_SELECTOR = "a[ui-sref='finance.covered']";
const SEARCH_INPUT_SELECTOR = "input#search, input[placeholder*='Check Number']";
const RESET_SEARCH_SELECTOR = "div[uib-popover='Reset search'], .close-btn[uib-popover*='Reset search']";
const SEARCH_BUTTON_SELECTOR = ".singleSearchButton, button[type='submit']";
const RESULT_ROW_SELECTOR = "tr.line-item";
const DOWNLOAD_ICON_SELECTOR = ".fa-arrow-circle-down";
const NO_RECORDS_SELECTOR = "text=/No records found\\./i";
const COVERED_RA_FORCED_TEXT_ROTATION = 90;

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

/*
###New Code -Start###
*/
async function waitForDownloadToStart(
  page: Page,
  clickDownload: () => Promise<void>,
  log: LogFn,
  checkNumber: string,
): Promise<Download> {
  let startedDownload: Download | null = null;
  const onDownload = (download: Download) => {
    startedDownload = download;
  };

  page.on("download", onDownload);
  try {
    await clickDownload();

    for (const elapsedSeconds of [5, 10, 15]) {
      await page.waitForTimeout(5000);
      if (startedDownload) {
        return startedDownload;
      }
      await log(`IEHP Covered RA download for ${checkNumber} is still starting. Waited ${elapsedSeconds} seconds...`);
    }

    if (startedDownload) {
      return startedDownload;
    }

    throw new Error(`PDF download did not start for Check Number ${checkNumber}.`);
  } finally {
    page.off("download", onDownload);
  }
}

function normalizeCoveredRaCheckNumber(checkNumber: string): string {
  return checkNumber.replace(/^EFT-/i, "").trim();
}

async function waitForCoveredRaResultRow(page: Page, checkNumber: string, log: LogFn): Promise<boolean> {
  const checkCurrentState = async (): Promise<boolean> => {
    const noRecordsMessage = page.locator(NO_RECORDS_SELECTOR).first();
    if (await noRecordsMessage.count() > 0 && await noRecordsMessage.isVisible().catch(() => false)) {
      throw new Error(`No IEHP Covered RA records were found for Check Number ${checkNumber}.`);
    }

    const rowCheckCell = page.locator(`${RESULT_ROW_SELECTOR} td`).filter({ hasText: checkNumber }).first();
    if (await rowCheckCell.count() > 0 && await rowCheckCell.isVisible().catch(() => false)) {
      return true;
    }

    return false;
  };

  if (await checkCurrentState()) {
    return true;
  }

  for (let elapsedSeconds = 5; elapsedSeconds <= 15; elapsedSeconds += 5) {
    await log(`IEHP Covered RA search for ${checkNumber} is still loading. Waiting ${elapsedSeconds} seconds...`);
    await page.waitForTimeout(5000);
    await waitForResultsToSettle(page);

    if (await checkCurrentState()) {
      return true;
    }
  }

  return false;
}
/*
###New Code - End###
*/

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
  const normalizedCheckNumber = normalizeCoveredRaCheckNumber(checkNumber);
  await log(`Searching IEHP Covered RAs for Check Number ${normalizedCheckNumber}...`);

  const resetSearch = page.locator(RESET_SEARCH_SELECTOR).first();
  if (await resetSearch.count() > 0 && await resetSearch.isVisible().catch(() => false)) {
    await resetSearch.click({ force: true }).catch(() => {});
    await page.waitForTimeout(300);
  }

  const searchInput = page.locator(SEARCH_INPUT_SELECTOR).first();
  await searchInput.fill(normalizedCheckNumber);
  await page.waitForTimeout(300);

  for (let searchAttempt = 0; searchAttempt < 2; searchAttempt++) {
    const searchButton = page.locator(SEARCH_BUTTON_SELECTOR).first();
    if (await searchButton.count() > 0 && await searchButton.isVisible().catch(() => false)) {
      await searchButton.click();
    } else {
      await searchInput.evaluate((el: HTMLInputElement) => {
        try {
          const ng = (window as any).angular;
          if (ng) {
            const scope = ng.element(el).scope();
            if (scope && scope.search && typeof scope.search.submit === "function") {
              scope.search.submit();
              if (!scope.$$phase && !scope.$root.$$phase) scope.$apply();
            }
          }
        } catch {}
      }).catch(() => {});

      await searchInput.press("Enter").catch(() => {});
    }

    await waitForResultsToSettle(page);

    /*
    ###New Code -Start###
    */
    if (await waitForCoveredRaResultRow(page, normalizedCheckNumber, log)) {
      return;
    }
    /*
    ###New Code - End###
    */
  }

  throw new Error(`No IEHP Covered RA row was found for Check Number ${normalizedCheckNumber}.`);
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

  const download = await waitForDownloadToStart(
    page,
    async () => {
      await downloadIcon.click({ force: true });
    },
    log,
    checkNumber,
  );

  return download;
}

type CoveredRaOptions = {
  page: Page;
  rowNumber: number;
  rowIndex: number;
  memberPolicyId: string;
  dosDate: Date;
  cpt: string;
  modifiers: string[];
  checkNumbers: string[];
  log: LogFn;
  sendEvent: (data: StreamEvent) => Promise<void>;
};

const COVERED_RA_FIXED_ROTATION: RotationCandidate = 270;

export async function processCoveredRaDownloads({
  page,
  rowNumber,
  rowIndex,
  memberPolicyId,
  dosDate,
  cpt,
  modifiers,
  checkNumbers,
  log,
  sendEvent,
}: CoveredRaOptions): Promise<RaDetailRecord[]> {
  const coveredRaDetails: RaDetailRecord[] = [];
  const uniqueChecks = Array.from(new Set(checkNumbers));

  if (uniqueChecks.length === 0) {
    return coveredRaDetails;
  }

  await log(`Row ${rowNumber}: Downloading Covered RAs for Check Numbers: ${uniqueChecks.join(", ")}`);
  await navigateToCoveredRaPage(page, log);

  for (let cIdx = 0; cIdx < uniqueChecks.length; cIdx++) {
    const chk = uniqueChecks[cIdx];
    await log(`Row ${rowNumber}: Processing Covered RA for Check Number ${chk} (${cIdx + 1}/${uniqueChecks.length})...`);

    await searchCoveredRaByCheckNumber(page, chk, log);
    const download = await downloadCoveredRaPdf(page, chk, log);

    const downloadsDir = path.join(os.tmpdir(), "downloads");
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
    const cleanDos = formatMmDdYyyy(dosDate).replace(/\//g, "-");
    const pdfFileName = `${rowIndex + 2}_${memberPolicyId}_${cleanDos}_${chk}.pdf`;
    const pdfPath = path.join(downloadsDir, pdfFileName);
    await download.saveAs(pdfPath);

    try {
      /*
      ###New Code -Start###
      */
      const originalPdfBuffer = fs.readFileSync(pdfPath);
      let matchedRecords: RaDetailRecord[] = [];

      await log(`Row ${rowNumber}: Best Covered RA PDF orientation selected as ${COVERED_RA_FIXED_ROTATION} degrees counterclockwise for the whole PDF.`);
      const candidatePdfBuffer = await rotatePdfBufferCounterClockwise(originalPdfBuffer, COVERED_RA_FIXED_ROTATION);
      fs.writeFileSync(pdfPath, candidatePdfBuffer);
      const pdfPages = await extractTextPagesFromPdf(originalPdfBuffer);
      const parsedRecords = parseRaDetailsFromPdfPages({
        pages: pdfPages,
        memberPolicyId,
        dosDate,
        cpt,
        modifiers,
        checkNumber: chk,
        preferLastTwoDashedMemberId: true,
        forcedTextRotation: COVERED_RA_FORCED_TEXT_ROTATION,
      });

      if (parsedRecords.length > 0) {
        matchedRecords = parsedRecords;
        await log(`Row ${rowNumber}: Covered RA PDF matched using ${COVERED_RA_FORCED_TEXT_ROTATION} degrees corrected text parsing.`);
      }

      /*
      ###New Code -Start###
      */
      await sendEvent({ type: "pdf_download", filename: pdfFileName, base64: candidatePdfBuffer.toString("base64") });
      /*
      ###New Code - End###
      */

      if (matchedRecords.length > 0) {
        coveredRaDetails.push(...matchedRecords);
      } else {
        const debugSummary =
          describeRaMatchFailureFromPdfPages({
            pages: pdfPages,
            memberPolicyId,
            dosDate,
            cpt,
            modifiers,
            preferLastTwoDashedMemberId: true,
            forcedTextRotation: COVERED_RA_FORCED_TEXT_ROTATION,
          });
        throw new Error(`No matching Covered RA detail line found in PDF for Check ${chk}, CPT ${cpt}, DOS ${formatMmDdYyyy(dosDate)}. ${debugSummary}`);
      }
      /*
      ###New Code - End###
      */
    } finally {
      try {
        fs.unlinkSync(pdfPath);
      } catch {
        await log(`Row ${rowNumber}: Warning: Could not delete temporary PDF ${pdfFileName}.`);
      }
    }
  }

  return coveredRaDetails;
}
