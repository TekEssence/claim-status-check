import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Download, Page } from "playwright-core";
import { formatMmDdYyyy } from "./claims/dates";
import { extractTextFromPdf, extractTextPagesFromPdf } from "./claims/pdf";
import { describeRaMatchFailureFromPdfPages, describeRaMatchFailureFromText, parseRaDetailsFromPdfPages, parseRaDetailsFromText, type RaDetailRecord } from "./claims/ra";
import { IEHP_SELECTORS } from "./selectors";

type StreamEvent = Record<string, unknown>;

type ReferRaOptions = {
  page: Page;
  rowNumber: number;
  rowIndex: number;
  memberPolicyId: string;
  dosDate: Date;
  cpt: string;
  modifiers: string[];
  checkNumbers: string[];
  log: (message: string) => Promise<void>;
  sendEvent: (data: StreamEvent) => Promise<void>;
};

async function waitForResultsToSettle(page: Page): Promise<void> {
  await page.locator(IEHP_SELECTORS.common.fullScreenLoader).waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
}

/*
###New Code -Start###
*/
async function submitClaimRaSearch(page: Page, searchInput: ReturnType<Page["locator"]>, log: (message: string) => Promise<void>, checkNumber: string): Promise<void> {
  const searchButton = page.locator(IEHP_SELECTORS.common.searchButton).first();
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
}

async function waitForDownloadToStart(
  page: Page,
  clickDownload: () => Promise<void>,
  log: (message: string) => Promise<void>,
  checkNumber: string,
): Promise<Download> {
  let startedDownload: Download | null = null;
  const onDownload = (download: Download) => {
    startedDownload = download;
  };

  page.on("download", onDownload);
  try {
    for (let clickAttempt = 1; clickAttempt <= 2; clickAttempt++) {
      await clickDownload();

      for (const elapsedSeconds of [5, 10, 15]) {
        await page.waitForTimeout(5000);
        if (startedDownload) {
          return startedDownload;
        }
        await log(`Claims RA download for ${checkNumber} is still starting. Waited ${elapsedSeconds} seconds...`);
      }

      if (startedDownload) {
        return startedDownload;
      }

      if (clickAttempt < 2) {
        await log(`Claims RA download for ${checkNumber} did not start after 15 seconds. Retrying download click once...`);
      }
    }

    if (startedDownload) {
      return startedDownload;
    }

    throw new Error(`PDF download did not start for Claims RA Check Number ${checkNumber}.`);
  } finally {
    page.off("download", onDownload);
  }
}

async function waitForClaimRaResultRow(page: Page, checkNumber: string, log: (message: string) => Promise<void>): Promise<boolean> {
  const checkCurrentState = async (): Promise<boolean> => {
    const noRecordsMessage = page.locator(IEHP_SELECTORS.common.noRecords).first();
    if (await noRecordsMessage.count() > 0 && await noRecordsMessage.isVisible().catch(() => false)) {
      throw new Error(`No Claims RA records were found for Check Number ${checkNumber}.`);
    }

    const rowEftLocator = page.locator(IEHP_SELECTORS.claimRa.resultCheckCell).first();
    if (await rowEftLocator.count() > 0 && await rowEftLocator.isVisible().catch(() => false)) {
      const rowEftText = await rowEftLocator.innerText().catch(() => "");
      if (rowEftText && rowEftText.includes(checkNumber)) {
        return true;
      }
    }

    return false;
  };

  if (await checkCurrentState()) {
    return true;
  }

  for (let elapsedSeconds = 5; elapsedSeconds <= 15; elapsedSeconds += 5) {
    await log(`Claims RA search for ${checkNumber} is still loading. Waiting ${elapsedSeconds} seconds...`);
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

async function navigateToClaimRaPage(page: Page, log: (message: string) => Promise<void>): Promise<void> {
  await log("Opening Finance tab for Claim RAs...");
  const financeToggle = page.locator(IEHP_SELECTORS.common.financeToggle).first();
  await financeToggle.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error("Finance tab was not found on the IEHP site.");
  });
  await financeToggle.click({ force: true });
  await page.waitForTimeout(750);

  await log("Opening Claims RAs...");
  const claimRaLink = page.locator(IEHP_SELECTORS.claimRa.link).first();
  await claimRaLink.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error("Claims RAs link was not found under the Finance tab.");
  });
  await claimRaLink.click({ force: true });
  await waitForResultsToSettle(page);
  await log("Claims RAs page opened. Waiting 4 seconds for the page to settle before searching...");
  await page.waitForTimeout(4000);

  const searchInput = page.locator(IEHP_SELECTORS.common.searchInput).first();
  await searchInput.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error("Check Number search input was not found on the Claims RAs page.");
  });
}

async function searchClaimRaByCheckNumber(page: Page, checkNumber: string, log: (message: string) => Promise<void>): Promise<void> {
  await log(`Searching Claims RAs for Check Number ${checkNumber}...`);

  const resetSearch = page.locator(IEHP_SELECTORS.claimRa.reset).first();
  if (await resetSearch.count() > 0 && await resetSearch.isVisible().catch(() => false)) {
    await resetSearch.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const searchInput = page.locator(IEHP_SELECTORS.common.searchInput).first();
  await searchInput.fill(checkNumber);
  await searchInput.evaluate((el: HTMLInputElement) => el.blur()).catch(() => {});
  await page.waitForTimeout(500);

  for (let searchAttempt = 0; searchAttempt < 2; searchAttempt++) {
    await submitClaimRaSearch(page, searchInput, log, checkNumber);

    /*
    ###New Code -Start###
    */
    if (await waitForClaimRaResultRow(page, checkNumber, log)) {
      return;
    }
    /*
    ###New Code - End###
    */
  }

  throw new Error(`No Claims RA row was found for Check Number ${checkNumber}.`);
}

async function downloadClaimRaPdf(page: Page, checkNumber: string, log: (message: string) => Promise<void>): Promise<Download> {
  await log(`Downloading PDF for Check Number ${checkNumber} from Claims RAs...`);

  /*
  ###New Code -Start###
  */
  const matchingRow = page.locator(IEHP_SELECTORS.common.resultRow).filter({
    has: page.locator("td:nth-child(3)", { hasText: checkNumber }),
  }).first();

  await matchingRow.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error(`Result row for Claims RA Check Number ${checkNumber} was not visible.`);
  });

  let pdfLink = matchingRow.locator(IEHP_SELECTORS.claimRa.download).first();
  /*
  ###New Code - End###
  */
  const hasPrimaryDownloadButton = await pdfLink.count().catch(() => 0);
  if (!hasPrimaryDownloadButton || !await pdfLink.isVisible().catch(() => false)) {
    pdfLink = matchingRow.locator(IEHP_SELECTORS.claimRa.downloadFallback).first();
  }

  await pdfLink.waitFor({ state: "visible", timeout: 15000 }).catch(() => {
    throw new Error(`Download button was not found for Claims RA Check Number ${checkNumber}.`);
  });

  const download = await waitForDownloadToStart(
    page,
    async () => {
      await pdfLink.click({ force: true });
    },
    log,
    checkNumber,
  );

  return download;
}

export async function processReferToRaDownloads({
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
}: ReferRaOptions): Promise<RaDetailRecord[]> {
  const referRaDetails: RaDetailRecord[] = [];
  const uniqueChecks = Array.from(new Set(checkNumbers));

  if (uniqueChecks.length === 0) {
    return referRaDetails;
  }

  await log(`Row ${rowNumber}: Downloading Claim RAs for Check Numbers: ${uniqueChecks.join(", ")}`);
  await navigateToClaimRaPage(page, log);

  for (let cIdx = 0; cIdx < uniqueChecks.length; cIdx++) {
    const chk = uniqueChecks[cIdx];
    await log(`Row ${rowNumber}: Processing Claim RA for Check Number ${chk} (${cIdx + 1}/${uniqueChecks.length})...`);

    await searchClaimRaByCheckNumber(page, chk, log);
    const download = await downloadClaimRaPdf(page, chk, log);

    const downloadsDir = path.join(os.tmpdir(), "downloads");
    if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
    const cleanDos = formatMmDdYyyy(dosDate).replace(/\//g, "-");
    const pdfFileName = `${rowIndex + 2}_${memberPolicyId}_${cleanDos}_${chk}.pdf`;
    const pdfPath = path.join(downloadsDir, pdfFileName);
    await download.saveAs(pdfPath);

    try {
      const pdfBuffer = fs.readFileSync(pdfPath);
      await sendEvent({ type: "pdf_download", filename: pdfFileName, base64: pdfBuffer.toString("base64") });

      const pdfText = await extractTextFromPdf(pdfBuffer);
      const pdfPages = await extractTextPagesFromPdf(pdfBuffer);
      const parsedRecords = parseRaDetailsFromPdfPages({
        pages: pdfPages,
        memberPolicyId,
        dosDate,
        cpt,
        modifiers,
        checkNumber: chk,
      });

      if (parsedRecords.length > 0) {
        referRaDetails.push(...parsedRecords);
      } else {
        const fallbackRecords = parseRaDetailsFromText({
          text: pdfText,
          memberPolicyId,
          dosDate,
          cpt,
          modifiers,
          checkNumber: chk,
        });

        if (fallbackRecords.length > 0) {
          referRaDetails.push(...fallbackRecords);
        } else {
          const debugSummary =
            describeRaMatchFailureFromPdfPages({
              pages: pdfPages,
              memberPolicyId,
              dosDate,
              cpt,
              modifiers,
            }) ||
            describeRaMatchFailureFromText({
              text: pdfText,
              memberPolicyId,
              dosDate,
              cpt,
              modifiers,
            });
          throw new Error(`No matching Claim RA detail line found in PDF for Check ${chk}, CPT ${cpt}, DOS ${formatMmDdYyyy(dosDate)}. ${debugSummary}`);
        }
      }
    } finally {
      try {
        fs.unlinkSync(pdfPath);
      } catch {
        await log(`Row ${rowNumber}: Warning: Could not delete temporary PDF ${pdfFileName}.`);
      }
    }
  }

  return referRaDetails;
}
