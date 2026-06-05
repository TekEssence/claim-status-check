import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import { formatMmDdYyyy } from "@/lib/claim-dates";
import { extractTextFromPdf } from "@/lib/claim-pdf";

type StreamEvent = Record<string, unknown>;

type ReferRaOptions = {
  page: Page;
  rowNumber: number;
  rowIndex: number;
  memberPolicyId: string;
  dosDate: Date;
  checkNumbers: string[];
  log: (message: string) => Promise<void>;
  sendEvent: (data: StreamEvent) => Promise<void>;
};

export async function processReferToRaDownloads({
  page,
  rowNumber,
  rowIndex,
  memberPolicyId,
  dosDate,
  checkNumbers,
  log,
  sendEvent,
}: ReferRaOptions): Promise<string[]> {
  const referRaDetails: string[] = [];
  const uniqueChecks = Array.from(new Set(checkNumbers));

  if (uniqueChecks.length === 0) {
    return referRaDetails;
  }

  await log(`Row ${rowNumber}: Downloading RAs sequentially for Check Numbers: ${uniqueChecks.join(", ")}`);

  try {
    await page.evaluate(() => {
      const injector = (window as any).angular && (window as any).angular.element(document.body).injector();
      if (injector) {
        injector.get("$state").go("finance.remittance");
      } else {
        window.location.hash = "/finance/remittance-advice";
      }
    });
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

    for (let cIdx = 0; cIdx < uniqueChecks.length; cIdx++) {
      const chk = uniqueChecks[cIdx];
      await log(`Row ${rowNumber}: Processing RA for Check Number ${chk} (${cIdx + 1}/${uniqueChecks.length})...`);

      let eftMatches = false;
      for (let searchAttempt = 0; searchAttempt < 2; searchAttempt++) {
        const searchAgainBtn = page.locator(".accordionPane:has(.search-again), h2.search-again").first();
        if (await searchAgainBtn.count() > 0 && await searchAgainBtn.isVisible()) {
          await searchAgainBtn.click({ timeout: 5000 });
          await page.waitForTimeout(500);
        }

        const searchInput = page.locator("input#search, input[placeholder*='Check Number']").first();
        await searchInput.fill(chk);
        await page.waitForTimeout(500);

        const searchBtn = page.locator(".singleSearchButton, button[type='submit']").first();
        if (await searchBtn.count() > 0 && await searchBtn.isVisible()) {
          await searchBtn.click();
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

          await searchInput.press("Enter");
        }

        await page.locator("div[full-screen-ajax-loader] .full-screen-bg").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

        for (let retry = 0; retry < 5; retry++) {
          const rowEftLocator = page.locator("tr.line-item td:nth-child(3)").first();
          if (await rowEftLocator.count() > 0 && await rowEftLocator.isVisible()) {
            const rowEftText = await rowEftLocator.innerText();
            if (rowEftText && rowEftText.includes(chk)) {
              eftMatches = true;
              break;
            }
          }
          await page.waitForTimeout(1000);
        }

        if (eftMatches) {
          break;
        }
      }

      if (!eftMatches) {
        throw new Error(`PDF download link not found for ${chk}: Search result EFT mismatch or page did not load after 2 search attempts.`);
      }

      const combinedPdfSelector = [
        "div[ng-click*='GetRaPdfDownload']",
        "div[uib-popover*='download Claim PDF']",
        ".fa-arrow-circle-down",
      ].join(", ");

      const pdfLink = page.locator(combinedPdfSelector).first();
      await pdfLink.waitFor({ state: "visible", timeout: 15000 }).catch(() => {});

      if (await pdfLink.isVisible()) {
        const [download] = await Promise.all([
          page.waitForEvent("download", { timeout: 25000 }).catch(() => null),
          pdfLink.click({ force: true }),
        ]);

        if (download) {
          const downloadsDir = path.join(os.tmpdir(), "downloads");
          if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });
          const cleanDos = formatMmDdYyyy(dosDate).replace(/\//g, "-");
          const pdfFileName = `${rowIndex + 2}_${memberPolicyId}_${cleanDos}_${chk}.pdf`;
          const pdfPath = path.join(downloadsDir, pdfFileName);
          await download.saveAs(pdfPath);

          const pdfBuffer = fs.readFileSync(pdfPath);
          await sendEvent({ type: "pdf_download", filename: pdfFileName, base64: pdfBuffer.toString("base64") });

          const pdfText = await extractTextFromPdf(pdfBuffer);
          const pdfLines = pdfText.split("\n").map((line) => line.trim()).filter(Boolean);
          const dosStr = formatMmDdYyyy(dosDate);
          let matchingLine = "";

          for (let j = 0; j < pdfLines.length; j++) {
            if (pdfLines[j].includes(memberPolicyId)) {
              let end = j + 1;
              while (end < pdfLines.length && end - j < 50) {
                if (/^\d{14}\b/.test(pdfLines[end])) break;
                end++;
              }
              const block = pdfLines.slice(j, end);
              if (block.some((line) => line.includes(dosStr))) {
                matchingLine = block.join(" ");
                break;
              }
            }
          }

          if (matchingLine) {
            referRaDetails.push(matchingLine);
          } else {
            referRaDetails.push(`Check ${chk}: No matching claim details found in PDF`);
          }
        } else {
          referRaDetails.push(`Check ${chk}: Error PDF download failed`);
        }
      } else {
        referRaDetails.push(`Check ${chk}: Error PDF download link not found`);
      }
    }
  } catch (err) {
    await log(`Row ${rowNumber}: Error handling RA batch download: ${(err as Error).message}`);
    referRaDetails.push(`Error: ${(err as Error).message}`);
  }

  return referRaDetails;
}
