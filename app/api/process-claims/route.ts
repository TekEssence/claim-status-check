import os from "node:os";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import { chromium as playwright, type BrowserContext, type Page } from "playwright-core";
import * as XLSX from "xlsx";
import {
  createProcessClaimJob,
  emitProcessClaimEvent,
  getProcessClaimJob,
  subscribeToProcessClaimJob,
  type ProcessClaimJobEvent,
} from "./jobs";
import { processReferToRaDownloads } from "./refer-ra";
import {
  asText,
  exactMmDdYyyyPattern,
  formatMmDdYyyy,
  getDosSearchRange,
  getPrimaryDosColumnIndex,
  parseDateInput,
  parseWebsiteMmDdYyyy,
} from "@/lib/claim-dates";
import { getClaimCptValue, serializeRaRecords, type RaDetailRecord } from "@/lib/claim-ra";
import { extractCheckNumbersFromClaimDetailText } from "./covered-ra";

type GenericRow = Record<string, unknown>;
type StreamEvent = Record<string, unknown>;

const SIGNED_IN_SELECTORS = [
  "li[ng-click='logOut()']",
  ".headerTopNav_signout",
  "text=/Sign\\s*Out/i",
  "text=/Eligibility/i",
  "text=/Welcome/i",
  "text=/My\\s*account/i",
];

const LOGIN_FAILED_SELECTOR = "text=/Login ID or Password entered is incorrect\\. Please re-enter and try again\\.(?:\\s*Attempts Remaining:\\s*\\d+)?/i";

function cleanLoginFailureMessage(message: string): string {
  return message.replace(/\s*Attempts Remaining:\s*\d+\s*$/i, "").replace(/\s+/g, " ").trim();
}

async function detectLoginStatus(page: Page, timeoutMs: number): Promise<{ status: "signed-in" | "failed" | "unknown"; message?: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const failureLocator = page.locator(LOGIN_FAILED_SELECTOR).first();
    if (await failureLocator.isVisible().catch(() => false)) {
      const text = await failureLocator.innerText().catch(() => "Login ID or Password entered is incorrect. Please re-enter and try again.");
      return { status: "failed", message: cleanLoginFailureMessage(text) };
    }

    for (const selector of SIGNED_IN_SELECTORS) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        return { status: "signed-in" };
      }
    }

    await page.waitForTimeout(500);
  }

  return { status: "unknown" };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes on Vercel Pro

export async function POST(req: Request) {
  const formData = await req.formData();
  const job = createProcessClaimJob();

  runProcessClaimsJob(job.id, formData).catch((error) => {
    const message = error instanceof Error ? error.message : "Unexpected automation error.";
    emitProcessClaimEvent(job.id, { type: "error", message });
    emitProcessClaimEvent(job.id, { type: "done" });
  });

  return Response.json({ jobId: job.id });
}

function getLastEventId(req: Request, url: URL): number {
  const fromQuery = Number(url.searchParams.get("after") || "0");
  const fromHeader = Number(req.headers.get("last-event-id") || "0");
  const lastEventId = Math.max(
    Number.isFinite(fromQuery) ? fromQuery : 0,
    Number.isFinite(fromHeader) ? fromHeader : 0,
  );
  return lastEventId > 0 ? lastEventId : 0;
}

function isTerminalJobStatus(status: string): boolean {
  return status === "done" || status === "error" || status === "cancelled";
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Content-Encoding": "none",
  };
}

function streamProcessClaimEvents(req: Request, jobId: string, afterEventId: number): Response {
  const encoder = new TextEncoder();
  const job = getProcessClaimJob(jobId);

  if (!job) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("id: 1\n"));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({
          type: "error",
          message: "Process claim job not found. Please start processing again.",
        })}\n\n`));
        controller.enqueue(encoder.encode("id: 2\n"));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "done" })}\n\n`));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: sseHeaders(),
    });
  }

  let cleanup = () => {};
  const abortHandler = () => cleanup();
  req.signal.addEventListener("abort", abortHandler, { once: true });

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      let keepAliveInterval: ReturnType<typeof setInterval> | undefined;
      let readyToCloseOnDone = false;
      let closeAfterSubscribe = false;

      cleanup = () => {
        if (closed) return;
        closed = true;
        if (keepAliveInterval) clearInterval(keepAliveInterval);
        unsubscribe();
        req.signal.removeEventListener("abort", abortHandler);
      };

      const close = () => {
        cleanup();
        try {
          controller.close();
        } catch {
          // The client may already have disconnected.
        }
      };

      const send = (event: ProcessClaimJobEvent) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`id: ${event.id}\n`));
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event.data)}\n\n`));
          if (event.data.type === "done") {
            if (readyToCloseOnDone) {
              close();
            } else {
              closeAfterSubscribe = true;
            }
          }
        } catch {
          close();
        }
      };

      keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          close();
        }
      }, 1000);

      unsubscribe = subscribeToProcessClaimJob(jobId, afterEventId, send);
      readyToCloseOnDone = true;
      if (closeAfterSubscribe) {
        close();
        return;
      }

      if (isTerminalJobStatus(job.status)) {
        const hasDoneEvent = job.events.some((event) => event.id > afterEventId && event.data.type === "done");
        if (!hasDoneEvent) {
          send({ id: job.events.length + 1, data: { type: "done" } });
        }
      }
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: sseHeaders(),
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");

  if (!jobId) {
    return Response.json({ error: "Missing process claim jobId." }, { status: 400 });
  }

  return streamProcessClaimEvents(req, jobId, getLastEventId(req, url));
}

async function runProcessClaimsJob(jobId: string, formData: FormData): Promise<void> {
  const sendEvent = async (data: StreamEvent) => {
    emitProcessClaimEvent(jobId, data);
    await new Promise(resolve => setTimeout(resolve, 50));
  };

  await sendEvent({ type: "padding", payload: "x".repeat(8192) });

  const log = async (message: string) => {
    await sendEvent({ type: "log", message });
  };

      try {
        const loginExcelFile = formData.get("loginExcel") as File | null;
        const claimRowsJson = formData.get("claimRows") as string | null;
        const startIndex = parseInt(formData.get("startIndex") as string || "0", 10);

        if (!loginExcelFile || !(loginExcelFile instanceof File) || !claimRowsJson) {
          await sendEvent({ type: "error", message: "Missing login Excel file or claim rows." });
          return;
        }

        const loginArrayBuffer = await loginExcelFile.arrayBuffer();
        const loginWorkbook = XLSX.read(loginArrayBuffer, { type: "array" });
        const loginSheetName = loginWorkbook.SheetNames[0];
        const loginSheet = loginWorkbook.Sheets[loginSheetName];
        const loginRows = XLSX.utils.sheet_to_json(loginSheet) as GenericRow[];

        if (loginRows.length === 0) {
          await sendEvent({ type: "error", message: "Login Excel file is empty." });
          return;
        }

        const firstLoginRow = loginRows[0];
        const rawUrl = asText(firstLoginRow["URL"] ?? firstLoginRow["url"]);
        const userName = asText(firstLoginRow["User Name"] ?? firstLoginRow["user name"] ?? firstLoginRow["username"]);
        const password = asText(firstLoginRow["Password"] ?? firstLoginRow["password"]);

        if (!rawUrl || !userName || !password) {
          await sendEvent({ type: "error", message: "Invalid login credentials format." });
          return;
        }

        const loginUrl = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
        const claimStatusUrl = asText(firstLoginRow["Claim Status URL"] ?? firstLoginRow["claim status url"] ?? firstLoginRow["claimUrl"]);
        const finalClaimStatusUrl = claimStatusUrl || "https://providers.iehp.org/claims/status";

        if (!claimStatusUrl) {
          await log("Warning: Claim Status URL not found in Excel. Using default fallback.");
        }

        const claimRows = JSON.parse(claimRowsJson) as GenericRow[];

        if (startIndex > 0) {
          await log(`Resuming processing from row ${startIndex + 1}...`);
        } else {
          await log(`Received ${claimRows.length} claim rows to process.`);
        }
        await sendEvent({ type: "progress", completed: startIndex, total: claimRows.length });

        log("Launching browser environment...");
        const isVercel = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV;
        const USE_CHROME_PROFILE = false;

        let browser;
        let context: BrowserContext | undefined;
        let page: Page | undefined;

        try {
          if (isVercel) {
            log("Attempting @sparticuz/chromium browser launch for Vercel.");
            browser = await playwright.launch({
              args: chromium.args,
              executablePath: await chromium.executablePath(),
              headless: true,
            });
            context = await browser.newContext({
              viewport: { width: 1280, height: 800 },
              userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            });
          } else {
            log("Attempting local Chromium launch.");
            if (USE_CHROME_PROFILE) {
              const profilePath = path.join(os.homedir(), "Library/Application Support/Google/Chrome");
              try {
                log(`Attempting persistent Chrome profile launch: ${profilePath}`);
                context = await playwright.launchPersistentContext(profilePath, {
                  channel: "chrome",
                  headless: false,
                  viewport: null,
                });
                browser = context.browser();
              } catch (e) {
                log(`Persistent profile launch failed, falling back: ${(e as Error).message}`);
                browser = await playwright.launch({ headless: true });
                context = await browser.newContext();
              }
            } else {
              browser = await playwright.launch({ headless: true });
              context = await browser.newContext();
            }
          }

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

            log(`Processing Row ${i + 1}: Member ${memberPolicyId}, DOS ${formatMmDdYyyy(dosDate)}`);

            try {
              log(`Row ${i + 1}: Navigating to Claims Status...`);
              await page.goto(finalClaimStatusUrl, {
                waitUntil: "networkidle",
                timeout: 60000,
              });

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

              const checkNumbersToDownload: string[] = [];

              while (true) {
                const matchingRows = getMatchingRows();
                const count = await matchingRows.count();

                if (count > 0) {
                  foundAny = true;
                  await log(`Row ${i + 1}: Found ${count} matching row(s) on page ${pageNum}.`);

                  // Collect details for each matching row on this page
                  for (let idx = 0; idx < count; idx++) {
                    try {
                      const currentLineItem = matchingRows.nth(idx);
                      const summaryText = (await currentLineItem.innerText({ timeout: 5000 })).replace(/\s+/g, " ").trim();
                      await currentLineItem.click({ timeout: 5000 });
                    // Use sibling tr.details after the matched line-item
                    const detailsRow = currentLineItem.locator("~ tr.details").first();
                    const detailsContent = detailsRow.locator('.details-content');
                    await detailsContent.waitFor({ state: "visible", timeout: 10000 });
                    const headerText = await detailsContent.locator('.details-header').innerText();
                    const tableText = await detailsContent.locator('table.table-condensed').innerText();

                    let statusInfoText = tableText.replace(/\s+/g, " ");

                    const fullDetailsText = (headerText + " " + statusInfoText).replace(/\s+/g, " ");
                    const foundCheckNumbers = extractCheckNumbersFromClaimDetailText(fullDetailsText);
                    if (foundCheckNumbers.length > 0) {
                      checkNumbersToDownload.push(...foundCheckNumbers);
                      await log(`Row ${i + 1}: Found Check Number(s) ${foundCheckNumbers.join(", ")} for Covered RA lookup.`);
                    } else if (/Refer/i.test(statusInfoText)) {
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
                const msg = `No matching claim rows on website (searched ${pageNum} page(s)).`;
                log(`Row ${i + 1}: Failed. ${msg}`);
                try {
                  const screenshot = await page.screenshot({ type: "jpeg", quality: 60 });
                  await sendEvent({ type: "error_screenshot", index: rowIndex, image: screenshot.toString("base64") });
                  const html = await page.evaluate(() => document.documentElement.outerHTML);
                  await sendEvent({ type: "debug_html", index: rowIndex, html });
                } catch { /* ignore */ }
                await sendEvent({
                  type: "row_update",
                  index: rowIndex,
                  update: { BotClaimDetails: "No matching rows found for DOS.", BotClaimStatusCheck: "Failed", BotClaimStatusCheckError: msg }
                });
                await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
                continue;
              }

              if (checkNumbersToDownload.length > 0) {
                if (!claimCpt) {
                  throw new Error("Refer to RA requires a CPT/procedure column in the claim Excel. Expected one of: CPT, CPT Code, Proc Code, Procedure Code.");
                }

                referRaDetails.push(...await processReferToRaDownloads({
                  page,
                  rowNumber: i + 1,
                  rowIndex,
                  memberPolicyId,
                  dosDate,
                  cpt: claimCpt,
                  checkNumbers: checkNumbersToDownload,
                  log,
                  sendEvent,
                }));
              }

              await log(`Row ${i + 1}: Success (${details.length} total matching rows across ${pageNum} page(s)).`);
              await sendEvent({
                type: "row_update",
                index: rowIndex,
                update: { 
                  BotClaimDetails: details.join(" | "), 
                  BotClaimStatusCheck: "Success", 
                  BotClaimStatusCheckError: "",
                  BotReferRA: referRaDetails.length > 0 ? serializeRaRecords(referRaDetails) : ""
                }
              });
              await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
            } catch (rowError) {
              const msg = rowError instanceof Error ? rowError.message : "Unknown row error";
              await log(`Row ${i + 1}: Failed. ${msg}`);
              
              // Capture screenshot and HTML on row failure
              try {
                const screenshot = await page.screenshot({ type: "jpeg", quality: 60 });
                await sendEvent({ type: "error_screenshot", index: rowIndex, image: screenshot.toString("base64") });
                
                const html = await page.evaluate(() => document.documentElement.outerHTML);
                await sendEvent({ type: "debug_html", index: rowIndex, html: html });
              } catch {
                await log("Failed to capture row error diagnostics.");
              }

              await sendEvent({
                type: "row_update",
                index: rowIndex,
                update: { BotClaimStatusCheck: "Failed", BotClaimStatusCheckError: msg }
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
