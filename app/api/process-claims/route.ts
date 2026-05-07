import os from "node:os";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import { chromium as playwright, type BrowserContext, type Page } from "playwright-core";
import * as XLSX from "xlsx";

type GenericRow = Record<string, unknown>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes on Vercel Pro

function asText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value).trim();
}

function parseDateInput(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value;
  }
  if (typeof value === "number") {
    const parsed = XLSX.SSF.parse_date_code(value);
    if (!parsed) {
      return null;
    }
    return new Date(parsed.y, parsed.m - 1, parsed.d);
  }
  const dateValue = asText(value);
  if (!dateValue) {
    return null;
  }
  const directParse = new Date(dateValue);
  if (!Number.isNaN(directParse.getTime())) {
    return directParse;
  }

  const parts = dateValue.split("/");
  if (parts.length !== 3) {
    return null;
  }
  const month = Number(parts[0]);
  const day = Number(parts[1]);
  const year = Number(parts[2]);
  const manualDate = new Date(year, month - 1, day);
  return Number.isNaN(manualDate.getTime()) ? null : manualDate;
}

function formatMmDdYyyy(date: Date): string {
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const y = String(date.getFullYear());
  return `${m}/${d}/${y}`;
}

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Keep-alive ping to prevent Vercel from buffering or dropping the connection
      const keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(keepAliveInterval);
        }
      }, 1000);

      const sendEvent = async (data: any) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          // Yield to event loop to allow Node.js to flush the socket
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch {
          // Stream closed
        }
      };

      // Pad the start to bypass Vercel/Cloudflare buffering limits (8KB)
      await sendEvent({ type: "padding", payload: "x".repeat(8192) });

      const log = async (message: string) => {
        await sendEvent({ type: "log", message });
      };

      try {
        const formData = await req.formData();
        const loginExcelFile = formData.get("loginExcel") as File | null;
        const claimRowsJson = formData.get("claimRows") as string | null;
        const startIndex = parseInt(formData.get("startIndex") as string || "0", 10);

        if (!loginExcelFile || !(loginExcelFile instanceof File) || !claimRowsJson) {
          await sendEvent({ type: "error", message: "Missing login Excel file or claim rows." });
          controller.close();
          return;
        }

        const loginArrayBuffer = await loginExcelFile.arrayBuffer();
        const loginWorkbook = XLSX.read(loginArrayBuffer, { type: "array" });
        const loginSheetName = loginWorkbook.SheetNames[0];
        const loginSheet = loginWorkbook.Sheets[loginSheetName];
        const loginRows = XLSX.utils.sheet_to_json(loginSheet) as GenericRow[];

        if (loginRows.length === 0) {
          await sendEvent({ type: "error", message: "Login Excel file is empty." });
          controller.close();
          return;
        }

        const firstLoginRow = loginRows[0];
        const rawUrl = asText(firstLoginRow["URL"] ?? firstLoginRow["url"]);
        const userName = asText(firstLoginRow["User Name"] ?? firstLoginRow["user name"] ?? firstLoginRow["username"]);
        const password = asText(firstLoginRow["Password"] ?? firstLoginRow["password"]);

        if (!rawUrl || !userName || !password) {
          await sendEvent({ type: "error", message: "Invalid login credentials format." });
          controller.close();
          return;
        }

        const loginUrl = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
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

          const loggedInIndicator = page.locator("a[href*='logout'], button[title*='logout'], text='Log Out', text='Sign Out', .user-profile").first();
          
          let isLoggedIn = false;
          try {
            await loggedInIndicator.waitFor({ state: "visible", timeout: 5000 });
            isLoggedIn = true;
            log("Already logged in (session persisted).");
          } catch {
            log("Not logged in. Proceeding with authentication...");
          }

          if (!isLoggedIn) {
            await page.locator("input[type='email']:visible, input[name*='user']:visible, input[id*='user']:visible").first().fill(userName);
            await page.locator("input[type='password']:visible, input[name*='pass']:visible, input[id*='pass']:visible").first().fill(password);
            
            const submitButton = page.locator("button[type='submit']:visible, input[type='submit']:visible, button:has-text('Sign In'):visible, button:has-text('Log In'):visible").first();
            await submitButton.click();
            
            log("Waiting for navigation after login...");
            await page.waitForNavigation({ waitUntil: "networkidle", timeout: 15000 }).catch(() => log("waitForNavigation timeout, continuing..."));
            
            try {
              await loggedInIndicator.waitFor({ state: "visible", timeout: 5000 });
              log("Login verification successful (indicator found).");
            } catch {
              log("Warning: Could not find strict logout indicator. Proceeding assuming login was successful...");
            }
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
            const memberPolicyId = asText(row["Member Policy ID"] ?? row["member policy id"] ?? row["Member ID"]);
            const dosValue = row["Date Of Service"] ?? row["DOS"] ?? row["date of service"];
            
            if (!memberPolicyId || !dosValue) {
              const msg = "Skipped: Missing Member ID or Date of Service.";
              log(`Row ${i + 1}: ${msg}`);
              sendEvent({
                type: "row_update",
                index: i,
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
                index: i,
                update: { BotClaimStatusCheck: "Skipped", BotClaimStatusCheckError: msg }
              });
              sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
              continue;
            }

            const startDate = new Date(dosDate);
            startDate.setDate(dosDate.getDate() - 1);
            const endDate = new Date(dosDate);
            endDate.setDate(dosDate.getDate() + 1);

            log(`Processing Row ${i + 1}: Member ${memberPolicyId}, DOS ${formatMmDdYyyy(dosDate)}`);

            try {
              log(`Row ${i + 1}: Navigating to Claims Status...`);
              await page.goto("https://providers.iehp.org/claims/status", {
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

              // --- Pagination loop: search each page for matching DOS rows ---
              const dosFormatted = formatMmDdYyyy(dosDate);
              let matchingRows = page.locator("tr.line-item", { hasText: dosFormatted });
              let count = await matchingRows.count();
              let pageNum = 1;

              while (count === 0) {
                // Check if "next page" button is enabled
                const nextBtn = page.locator("li.pagination-next:not(.disabled) a").first();
                const nextEnabled = await nextBtn.count() > 0;
                if (!nextEnabled) break; // No more pages

                await log(`Row ${i + 1}: DOS not found on page ${pageNum}, going to next page...`);
                await nextBtn.click();
                await page.locator('div[full-screen-ajax-loader] .full-screen-bg').waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
                await page.waitForLoadState("networkidle", { timeout: 15000 });
                pageNum++;

                matchingRows = page.locator("tr.line-item", { hasText: dosFormatted });
                count = await matchingRows.count();
              }

              if (count === 0) {
                const msg = `No matching claim rows on website (searched ${pageNum} page(s)).`;
                log(`Row ${i + 1}: Failed. ${msg}`);
                
                try {
                  const screenshot = await page.screenshot({ type: "jpeg", quality: 60 });
                  await sendEvent({ type: "error_screenshot", index: i, image: screenshot.toString("base64") });
                  const html = await page.evaluate(() => document.documentElement.outerHTML);
                  await sendEvent({ type: "debug_html", index: i, html });
                } catch { /* ignore */ }

                await sendEvent({
                  type: "row_update",
                  index: i,
                  update: { BotClaimDetails: "No matching rows found for DOS.", BotClaimStatusCheck: "Failed", BotClaimStatusCheckError: msg }
                });
                await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
                continue;
              }

              await log(`Row ${i + 1}: Found ${count} matching row(s) on page ${pageNum}.`);

              // Collect details from all matching rows on this page
              const details: string[] = [];
              for (let index = 0; index < count; index += 1) {
                const currentLineItem = matchingRows.nth(index);
                const summaryText = (await currentLineItem.innerText()).replace(/\s+/g, " ").trim();
                
                await currentLineItem.click();
                const detailsRow = page.locator(`tr.line-item:has-text("${dosFormatted}") ~ tr.details`).nth(index);
                const detailsContent = detailsRow.locator('.details-content');
                
                await detailsContent.waitFor({ state: "visible", timeout: 10000 });
                const headerText = await detailsContent.locator('.details-header').innerText();
                const tableText = await detailsContent.locator('table.table-condensed').innerText();
                
                const fullDetails = `Summary: [${summaryText}] | Details: [${headerText.replace(/\s+/g, " ")}] | Status Info: [${tableText.replace(/\s+/g, " ")}]`;
                details.push(fullDetails);
              }

              await log(`Row ${i + 1}: Success (${count} matching rows on page ${pageNum}).`);
              await sendEvent({
                type: "row_update",
                index: i,
                update: { BotClaimDetails: details.join(" | "), BotClaimStatusCheck: "Success", BotClaimStatusCheckError: "" }
              });
              await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
            } catch (rowError) {
              const msg = rowError instanceof Error ? rowError.message : "Unknown row error";
              await log(`Row ${i + 1}: Failed. ${msg}`);
              
              // Capture screenshot and HTML on row failure
              try {
                const screenshot = await page.screenshot({ type: "jpeg", quality: 60 });
                await sendEvent({ type: "error_screenshot", index: i, image: screenshot.toString("base64") });
                
                const html = await page.evaluate(() => document.documentElement.outerHTML);
                await sendEvent({ type: "debug_html", index: i, html: html });
              } catch (screenshotError) {
                await log("Failed to capture row error diagnostics.");
              }

              await sendEvent({
                type: "row_update",
                index: i,
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
        clearInterval(keepAliveInterval);
        await sendEvent({ type: "done" });
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "none",
    },
  });
}
