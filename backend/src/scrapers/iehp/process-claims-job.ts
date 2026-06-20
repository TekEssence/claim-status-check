import type { BrowserContext, Page } from "playwright-core";
import { emitProcessClaimEvent } from "@/backend/src/jobs/job-store";
import { processCoveredRaDownloads, extractCheckNumbersFromClaimDetailText } from "@/backend/src/scrapers/iehp/covered-ra";
import { processReferToRaDownloads } from "@/backend/src/scrapers/iehp/refer-ra";
import { detectLoginStatus } from "@/backend/src/scrapers/iehp/auth";
import { launchIehpBrowser } from "./browser";
import { parseIehpProcessClaimsInput } from "./input";
import { navigateToClaimStatusWithRetry } from "./claim-status";
import {
  buildExpandedDetailSummary,
  formatNearestDosCandidates,
  inspectExpandedClaimRow,
  uniqueNearestDetailCandidates,
  type ClaimDetailLineCandidate,
} from "./claim-details";
import {
  captureRowDiagnostics,
  isMainClaimSearchMessage,
  isRaDetailNoMatchMessage,
} from "./diagnostics";
import {
  asText,
  exactMmDdYyyyPattern,
  formatMmDdYyyy,
  getDosSearchRange,
  getPrimaryDosColumnIndex,
  getReceivedColumnIndex,
  parseDateInput,
  parseWebsiteMmDdYyyy,
} from "./claims/dates";
import { getClaimCptValue, getClaimModifierValues, serializeRaRecords, type RaDetailRecord } from "./claims/ra";

type StreamEvent = Record<string, unknown>;

export async function runProcessClaimsJob(jobId: string, formData: FormData): Promise<void> {
  const sendEvent = async (data: StreamEvent) => {
    emitProcessClaimEvent(jobId, data);
    await new Promise(resolve => setTimeout(resolve, 50));
  };

  await sendEvent({ type: "padding", payload: "x".repeat(8192) });

  const log = async (message: string) => {
    await sendEvent({ type: "log", message });
  };

      try {
        const {
          loginUrl,
          claimStatusUrl: finalClaimStatusUrl,
          claimStatusUrlWasProvided,
          userName,
          password,
          claimRows,
          startIndex,
        } = await parseIehpProcessClaimsInput(formData);

        if (!claimStatusUrlWasProvided) {
          await log("Warning: Claim Status URL not found in Excel. Using default fallback.");
        }

        if (startIndex > 0) {
          await log(`Resuming processing from row ${startIndex + 1}...`);
        } else {
          await log(`Received ${claimRows.length} claim rows to process.`);
        }
        await sendEvent({ type: "progress", completed: startIndex, total: claimRows.length });

        log("Launching browser environment...");
        let browser;
        let context: BrowserContext | undefined;
        let page: Page | undefined;

        try {
          const browserSession = await launchIehpBrowser(log);
          browser = browserSession.browser;
          context = browserSession.context;

          if (!browser || !context) {
            throw new Error("Failed to initialize browser instance.");
          }

          page = await context.newPage();
          page.setDefaultTimeout(30000);

          log(`Navigating to login URL: ${loginUrl}`);
          await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForLoadState("networkidle", { timeout: 30000 });

          const initialLoginStatus = await detectLoginStatus(page, 5000);
          if (initialLoginStatus.status === "failed") {
            throw new Error(`Login failed: ${initialLoginStatus.message}`);
          }

          const isLoggedIn = initialLoginStatus.status === "signed-in";
          if (isLoggedIn) {
            await log("Already logged in (session persisted).");
          } else {
            await log("Not logged in. Proceeding with authentication...");
          }

          if (!isLoggedIn) {
            await page.locator("input[type='email']:visible, input[name*='user']:visible, input[id*='user']:visible").first().fill(userName);
            await page.locator("input[type='password']:visible, input[name*='pass']:visible, input[id*='pass']:visible").first().fill(password);
            
            const submitButton = page.locator("button[type='submit']:visible, input[type='submit']:visible, button:has-text('Sign In'):visible, button:has-text('Log In'):visible").first();
            await submitButton.click();
            
            log("Waiting for navigation after login...");
            await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => log("waitForNavigation timeout, continuing..."));

            const loginOutcome = await detectLoginStatus(page, 15000);
            if (loginOutcome.status === "failed") {
              throw new Error(`Login failed: ${loginOutcome.message}`);
            }
            if (loginOutcome.status !== "signed-in") {
              throw new Error("Login verification failed: could not find Sign Out, Eligibility, Welcome, or My account after submitting credentials.");
            }
            await log("Login verification successful (signed-in indicator found).");
          }

          const processStartTime = Date.now();
          const MAX_EXECUTION_TIME_MS = 4 * 60 * 1000; // 4 minutes
          const BATCH_SIZE = 10;
          let processedInThisBatch = 0;

          for (let i = startIndex; i < claimRows.length; i++) {
            // Check for timeout or batch limit
            if (Date.now() - processStartTime > MAX_EXECUTION_TIME_MS || processedInThisBatch >= BATCH_SIZE) {
              await log(`Batch complete. Pausing at Row ${i + 1} to gracefully auto-resume the next chunk...`);
              break; // Break the loop, the finally block will emit 'done' and the frontend will re-trigger
            }

            const row = claimRows[i];
            const rowIndex = typeof (row as any).__original_index === "number" ? (row as any).__original_index : i;
            const memberPolicyId = asText(row["Member Policy ID"] ?? row["member policy id"] ?? row["Member ID"] ?? row["member id"]);
            const dosValue = row["Date Of Service"] ?? row["DOS"] ?? row["date of service"] ?? row["dos"];
            const claimCpt = getClaimCptValue(row);
            const claimModifiers = getClaimModifierValues(row);


            
            if (!memberPolicyId || !dosValue || memberPolicyId === "NaN" || dosValue === "NaN") {
              const msg = "Skipped: Missing or Invalid Member ID / Date of Service.";
              await log(`Row ${i + 1}: ${msg}`);
              sendEvent({
                type: "row_update",
                index: rowIndex,
                update: { BotClaimStatusCheck: "Skipped", BotClaimStatusCheckError: msg }
              });
              sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
              continue;
            }

            const dosDate = parseDateInput(dosValue);
            if (!dosDate) {
              const msg = `Skipped: Invalid Date of Service format: ${dosValue}`;
              log(`Row ${i + 1}: ${msg}`);
              sendEvent({
                type: "row_update",
                index: rowIndex,
                update: { BotClaimStatusCheck: "Skipped", BotClaimStatusCheckError: msg }
              });
              sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
              continue;
            }

            const { startDate, endDate } = getDosSearchRange(dosDate);
            let claimDetailsText = "";
            let referRaPayload = "";

            log(`Processing Row ${i + 1}: Member ${memberPolicyId}, DOS ${formatMmDdYyyy(dosDate)}`);

            try {
              /*
              ###New Code -Start###
              */
              await navigateToClaimStatusWithRetry(page, finalClaimStatusUrl, i + 1, log);
              /*
              ###New Code - End###
              */

              await page.locator("input[name='expressionBox']:visible").first().fill(memberPolicyId);
              
              // Open Options panel
              const optionsBtn = page.locator("div.advanced-search");
              await optionsBtn.click();
              await page.waitForTimeout(1000);

              // Ensure DOS filter is ON. Check state and click only if OFF.
              const isDosChecked = await page.locator(".claim-status-adv-input.active").count() > 0;
              if (!isDosChecked) {
                await page.locator("label[ng-click*='dateRange']").first().click({ force: true });
                await page.waitForTimeout(500);
              }

              await page.locator("input.min-range:visible, input[ng-model='search.minRange']:visible").first().fill(formatMmDdYyyy(startDate));
              await page.locator("input.max-range:visible, input[ng-model='search.maxRange']:visible").first().fill(formatMmDdYyyy(endDate));

              // Final validation before Search: the page may have toggled the filter off
              // after we filled the date inputs. Re-enable if needed (up to 3 attempts).
              for (let attempt = 0; attempt < 3; attempt++) {
                const activeNow = await page.locator(".claim-status-adv-input.active").count() > 0;
                if (activeNow) break;
                await log(`Row ${i + 1}: DOS filter toggled off before search (attempt ${attempt + 1}). Re-enabling...`);
                await page.locator("label[ng-click*='dateRange']").first().click({ force: true });
                await page.waitForTimeout(300);
              }

              await page.locator("button.singleSearchButton:visible, button[ng-click='search.submit()']:visible").first().click();

              await page.locator('div[full-screen-ajax-loader] .full-screen-bg').waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
              await page.waitForLoadState("networkidle", { timeout: 30000 });

              // --- Detect sort order by comparing first two result rows ---
              const dosFormatted = formatMmDdYyyy(dosDate);
              const details: string[] = [];
              const referRaDetails: RaDetailRecord[] = [];
              let pageNum = 1;
              let foundAny = false;

              // Extract a date from a row — reads only the Primary DOS cell when column index is known
              const extractDosFromRow = async (rowLocator: { innerText: () => Promise<string>; locator?: (s: string) => { innerText: () => Promise<string> } }, colIdx = -1): Promise<Date | null> => {
                let text = "";
                if (colIdx > 0 && "locator" in rowLocator && rowLocator.locator) {
                  text = await rowLocator.locator(`td:nth-child(${colIdx})`).innerText().catch(() => "");
                } else {
                  text = await rowLocator.innerText().catch(() => "");
                }
                return parseWebsiteMmDdYyyy(text);
              };

              // Find the column index of "Primary DOS" in the results table header FIRST
              // so we ONLY match that column and not the "Received" or other date columns.
              const headerCells = page.locator("tr.header-row th, thead tr th, tr:first-of-type th");
              const headerCount = await headerCells.count();
              const headerTexts: string[] = [];
              for (let h = 0; h < headerCount; h++) {
                headerTexts.push(await headerCells.nth(h).innerText());
              }
              const primaryDosColIndex = getPrimaryDosColumnIndex(headerTexts);
              await log(`Row ${i + 1}: Primary DOS column index: ${primaryDosColIndex === -1 ? "not found (falling back to row text match)" : primaryDosColIndex}`);
              const receivedColIndex = getReceivedColumnIndex(headerTexts);
              await log(`Row ${i + 1}: Received column index: ${receivedColIndex === -1 ? "not found" : receivedColIndex}`);

              const allRows = page.locator("tr.line-item");
              const totalRows = await allRows.count();
              let sortDescending: boolean | null = null; // null = unknown (can't determine)

              // Scan rows until we find two with DIFFERENT dates to determine sort order
              let firstSeenDate: Date | null = null;
              for (let r = 0; r < totalRows; r++) {
                const d = await extractDosFromRow(allRows.nth(r), primaryDosColIndex);
                if (!d) continue;
                if (!firstSeenDate) { firstSeenDate = d; continue; }
                if (d.getTime() !== firstSeenDate.getTime()) {
                  sortDescending = firstSeenDate >= d;
                  await log(`Row ${i + 1}: Detected sort order: ${sortDescending ? "Descending (newest first)" : "Ascending (oldest first)"}`);
                  break;
                }
              }
              if (sortDescending === null) {
                await log(`Row ${i + 1}: Could not detect sort order (all visible rows same date) — early-exit disabled.`);
              }

              // Build a locator that matches tr.line-item rows where the Primary DOS td equals dosFormatted.
              // Falls back to hasText on whole row if column not found.
              const getMatchingRows = () => {
                if (primaryDosColIndex > 0) {
                  return page!.locator("tr.line-item").filter({
                    has: page!.locator(`td:nth-child(${primaryDosColIndex})`, { hasText: exactMmDdYyyyPattern(dosFormatted) })
                  });
                }
                return page!.locator("tr.line-item", { hasText: dosFormatted });
              };

              const claimRaCheckNumbers: string[] = [];
              const coveredRaCheckNumbers: string[] = [];
              const nearestDetailDosCandidates: ClaimDetailLineCandidate[] = [];
              let selectedLatestReceivedRowOnly = false;

              while (true) {
                let matchingRows = getMatchingRows();
                let count = await matchingRows.count();

                if (count > 0) {
                  foundAny = true;
                  await log(`Row ${i + 1}: Found ${count} matching row(s) on page ${pageNum}.`);

                  /*
                  ###New Code -Start###
                  */
                  if (count > 1 && receivedColIndex > 0) {
                    let latestReceivedTime = Number.NEGATIVE_INFINITY;
                    let latestReceivedRowIndex = 0;

                    for (let idx = 0; idx < count; idx++) {
                      const receivedText = await matchingRows.nth(idx).locator(`td:nth-child(${receivedColIndex})`).innerText().catch(() => "");
                      const receivedDate = parseWebsiteMmDdYyyy(receivedText);
                      const receivedTime = receivedDate ? receivedDate.getTime() : Number.NEGATIVE_INFINITY;

                      if (receivedTime > latestReceivedTime) {
                        latestReceivedTime = receivedTime;
                        latestReceivedRowIndex = idx;
                      }
                    }

                    matchingRows = matchingRows.nth(latestReceivedRowIndex);
                    count = await matchingRows.count();
                    selectedLatestReceivedRowOnly = true;
                    await log(`Row ${i + 1}: Multiple DOS matches found. Selected the row with the latest Received date.`);
                  }
                  /*
                  ###New Code - End###
                  */

                  // Collect details for each matching row on this page
                  for (let idx = 0; idx < count; idx++) {
                    try {
                      const currentLineItem = matchingRows.nth(idx);
                      const inspection = await inspectExpandedClaimRow(currentLineItem, dosDate, claimCpt, claimModifiers);
                      const { summaryText, headerText, statusInfoText, fullDetailsText } = inspection;
                      const hasReferToRa = /Refer to your RA/i.test(fullDetailsText);
                      const foundCheckNumbers = extractCheckNumbersFromClaimDetailText(fullDetailsText);
                      if (foundCheckNumbers.length > 0) {
                      if (hasReferToRa) {
                        claimRaCheckNumbers.push(...foundCheckNumbers);
                        await log(`Row ${i + 1}: Found Claim RA Check Number(s) ${foundCheckNumbers.join(", ")}.`);
                      } else {
                        coveredRaCheckNumbers.push(...foundCheckNumbers);
                        await log(`Row ${i + 1}: Found Covered RA Check Number(s) ${foundCheckNumbers.join(", ")}.`);
                      }
                    } else if (hasReferToRa) {
                      await log(`Row ${i + 1}: 'Refer to your RA' text found, but no Check Number was present in the details block.`);
                    }

                    details.push(`Summary: [${summaryText}] | Details: [${headerText.replace(/\s+/g, " ")}] | Status Info: [${statusInfoText}]`);
                  } catch (innerError) {
                    await log(`Row ${i + 1}: Warning: Could not process remaining matching rows on this page (likely due to DOM reset after navigating back). Skipping remaining matches on page.`);
                    break;
                  }
                }

                  // Check if the last matching row is also the last row on this page.
                  // If so, the DOS might continue on the next page.
                  const allLineItems = page.locator("tr.line-item");
                  const totalOnPage = await allLineItems.count();
                  const lastMatchText = await matchingRows.nth(count - 1).innerText();
                  const lastPageText  = await allLineItems.nth(totalOnPage - 1).innerText();
                  const dosIsLastRow = lastMatchText.trim() === lastPageText.trim();

                  const nextBtn = page.locator("li.pagination-next:not(.disabled) a").first();
                  const hasNextPage = await nextBtn.count() > 0;

                  if (selectedLatestReceivedRowOnly) {
                    await log(`Row ${i + 1}: Using only the latest Received Date match for this claim.`);
                    break;
                  }

                  if (dosIsLastRow && hasNextPage) {
                    await log(`Row ${i + 1}: DOS is last row on page ${pageNum}, checking next page for more...`);
                    await nextBtn.click();
                    await page.locator('div[full-screen-ajax-loader] .full-screen-bg').waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
                    await page.waitForLoadState("networkidle", { timeout: 15000 });
                    pageNum++;
                    continue; // Check next page for more matches
                  }

                  break; // DOS found, not on last row (or no next page) — we're done
                }

                let detailLevelMatchFound = false;
                const currentPageRows = page.locator("tr.line-item");
                const currentPageRowCount = await currentPageRows.count();

                /*
                ###New Code -Start###
                */
                await log(`Row ${i + 1}: Exact DOS was not found in the main claim rows on page ${pageNum}. Checking expanded claim detail lines for a detailed-page DOS match...`);
                /*
                ###New Code - End###
                */

                for (let rowIdx = 0; rowIdx < currentPageRowCount; rowIdx++) {
                  try {
                    const inspection = await inspectExpandedClaimRow(currentPageRows.nth(rowIdx), dosDate, claimCpt, claimModifiers);
                    nearestDetailDosCandidates.push(...inspection.nearestCandidates);

                    if (!inspection.exactMatch) {
                      continue;
                    }

                    foundAny = true;
                    detailLevelMatchFound = true;

                    const fullDetailsText = inspection.fullDetailsText;
                    const hasReferToRa = /Refer to your RA/i.test(fullDetailsText);
                    const foundCheckNumbers = extractCheckNumbersFromClaimDetailText(fullDetailsText);
                    if (foundCheckNumbers.length > 0) {
                      if (hasReferToRa) {
                        claimRaCheckNumbers.push(...foundCheckNumbers);
                        await log(`Row ${i + 1}: Found Claim RA Check Number(s) ${foundCheckNumbers.join(", ")} from expanded claim line details.`);
                      } else {
                        coveredRaCheckNumbers.push(...foundCheckNumbers);
                        await log(`Row ${i + 1}: Found Covered RA Check Number(s) ${foundCheckNumbers.join(", ")} from expanded claim line details.`);
                      }
                    } else if (hasReferToRa) {
                      await log(`Row ${i + 1}: Expanded claim line details showed 'Refer to your RA', but no Check Number was present in the details block.`);
                    }

                    const matchedLine = inspection.exactMatch;
                    /*
                    ###New Code -Start###
                    */
                    const detailSummaryText = buildExpandedDetailSummary(matchedLine, inspection.summaryText);
                    /*
                    ###New Code - End###
                    */

                    details.push(
                      `Summary: [${detailSummaryText}] | Details: [${inspection.headerText.replace(/\s+/g, " ")}] | Status Info: [${inspection.statusInfoText}]`,
                    );
                    await log(`Row ${i + 1}: DOS matched in expanded claim line details on page ${pageNum}.`);
                    break;
                  } catch (detailInspectionError) {
                    await log(`Row ${i + 1}: Warning: Could not inspect expanded claim details for a nearby DOS on page ${pageNum}.`);
                    continue;
                  }
                }

                /*
                ###New Code -Start###
                */
                if (!detailLevelMatchFound) {
                  const pageNearestDosText = formatNearestDosCandidates(uniqueNearestDetailCandidates(nearestDetailDosCandidates, 3));
                  if (pageNearestDosText) {
                    await log(`Row ${i + 1}: Detailed-page nearest DOS candidates so far: ${pageNearestDosText}.`);
                  } else {
                    await log(`Row ${i + 1}: Detailed page did not expose any usable DOS candidates on page ${pageNum}.`);
                  }
                }
                /*
                ###New Code - End###
                */

                if (detailLevelMatchFound) {
                  break;
                }

                // No match on this page.
                // Early-exit: only if sort order is known — if first row has passed our target, stop.
                if (sortDescending !== null) {
                  const firstRowDos = await extractDosFromRow(page.locator("tr.line-item").first(), primaryDosColIndex);
                  if (firstRowDos) {
                    const targetTime = dosDate.getTime();
                    const firstTime = firstRowDos.getTime();
                    const passedTarget = sortDescending
                      ? firstTime < targetTime
                      : firstTime > targetTime;
                    if (passedTarget) {
                      await log(`Row ${i + 1}: Sort-aware early exit on page ${pageNum} — target DOS not in results.`);
                      break;
                    }
                  }
                }

                const nextBtn = page.locator("li.pagination-next:not(.disabled) a").first();
                const hasNextPage = await nextBtn.count() > 0;
                if (!hasNextPage) break;

                await log(`Row ${i + 1}: DOS not found on page ${pageNum}, going to next page...`);
                await nextBtn.click();
                await page.locator('div[full-screen-ajax-loader] .full-screen-bg').waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
                await page.waitForLoadState("networkidle", { timeout: 15000 });
                pageNum++;
              }

              if (!foundAny) {
                /*
                ###New Code -Start###
                */
                const nearestDosCandidates = uniqueNearestDetailCandidates(nearestDetailDosCandidates, 3);
                const formattedNearestDosText = formatNearestDosCandidates(nearestDosCandidates);
                /*
                ###New Code - End###
                */
                const msg = nearestDosCandidates.length > 0
                  ? `No matching claim rows on website (searched ${pageNum} page(s)). Nearest DOS in expanded claim details: ${formattedNearestDosText}.`
                  : `No matching claim rows on website (searched ${pageNum} page(s)).`;
                log(`Row ${i + 1}: Failed. ${msg}`);
                await captureRowDiagnostics({
                  jobId,
                  page,
                  rowIndex,
                  rowNumber: i + 1,
                  reason: "no-main-claim-match",
                  sendEvent,
                  log,
                });
                await sendEvent({
                  type: "row_update",
                  index: rowIndex,
                  update: { BotClaimDetails: "No matching rows found for DOS.", BotClaimStatusCheck: "Failed", BotClaimStatusCheckError: msg }
                });
                await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
                continue;
              }

              claimDetailsText = details.join(" | ");
              await sendEvent({
                type: "row_update",
                index: rowIndex,
                update: {
                  BotClaimDetails: claimDetailsText,
                }
              });

              if (claimRaCheckNumbers.length > 0 || coveredRaCheckNumbers.length > 0) {
                if (!claimCpt) {
                  throw new Error("Refer to RA requires a CPT/procedure column in the claim Excel. Expected one of: CPT, CPT Code, Proc Code, Procedure Code.");
                }
              }

              if (claimRaCheckNumbers.length > 0) {
                referRaDetails.push(...await processReferToRaDownloads({
                  page,
                  rowNumber: i + 1,
                  rowIndex,
                  memberPolicyId,
                  dosDate,
                  cpt: claimCpt,
                  modifiers: claimModifiers,
                  checkNumbers: claimRaCheckNumbers,
                  log,
                  sendEvent,
                }));
              }

              if (coveredRaCheckNumbers.length > 0) {
                referRaDetails.push(...await processCoveredRaDownloads({
                  page,
                  rowNumber: i + 1,
                  rowIndex,
                  memberPolicyId,
                  dosDate,
                  cpt: claimCpt,
                  modifiers: claimModifiers,
                  checkNumbers: coveredRaCheckNumbers,
                  log,
                  sendEvent,
                }));
              }

              referRaPayload = referRaDetails.length > 0 ? serializeRaRecords(referRaDetails) : "";

              await log(`Row ${i + 1}: Success (${details.length} total matching rows across ${pageNum} page(s)).`);
              await sendEvent({
                type: "row_update",
                index: rowIndex,
                update: { 
                  BotClaimDetails: claimDetailsText, 
                  BotClaimStatusCheck: "Success", 
                  BotClaimStatusCheckError: "",
                  BotReferRA: referRaPayload
                }
              });
              await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
            } catch (rowError) {
              const msg = rowError instanceof Error ? rowError.message : "Unknown row error";
              const isRaDetailNoMatch = isRaDetailNoMatchMessage(msg);
              const shouldCaptureMainDiagnostics = isMainClaimSearchMessage(msg);
              await log(`Row ${i + 1}: ${isRaDetailNoMatch ? "Completed with RA note" : "Failed"}. ${msg}`);
              
              // Capture screenshot and HTML on row failure
              if (shouldCaptureMainDiagnostics) {
                await captureRowDiagnostics({
                  jobId,
                  page,
                  rowIndex,
                  rowNumber: i + 1,
                  reason: "main-claim-search-error",
                  sendEvent,
                  log,
                });
              }

              await sendEvent({
                type: "row_update",
                index: rowIndex,
                update: {
                  BotClaimDetails: claimDetailsText || undefined,
                  BotClaimStatusCheck: isRaDetailNoMatch ? "Success" : "Failed",
                  BotClaimStatusCheckError: msg,
                  BotReferRA: referRaPayload || undefined,
                }
              });
              await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
            }

            processedInThisBatch++;
          }
        } finally {
          await page?.close().catch(() => {});
          await context?.close().catch(() => {});
          await browser?.close().catch(() => {});
        }
      } catch (globalError) {
        const msg = globalError instanceof Error ? globalError.message : "Unexpected automation error.";
        await log(`Global automation error: ${msg}`);
        await sendEvent({ type: "error", message: msg });
      } finally {
        await sendEvent({ type: "done" });
      }
}
