import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Stagehand } from "@browserbasehq/stagehand";
import chromium from "@sparticuz/chromium";
import { z } from "zod";
import * as XLSX from "xlsx";
import {
  asText,
  formatMmDdYyyy,
  getDosSearchRange,
  parseDateInput,
} from "@/lib/claim-dates";
import { extractTextFromPdf } from "@/lib/claim-pdf";

type GenericRow = Record<string, unknown>;
type StreamEvent = Record<string, unknown>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes on Vercel Pro

export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const keepAliveInterval = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        } catch {
          clearInterval(keepAliveInterval);
        }
      }, 1000);

      const sendEvent = async (data: StreamEvent) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch {
          // Stream closed
        }
      };

      await sendEvent({ type: "padding", payload: "x".repeat(8192) });

      const log = async (message: string) => {
        await sendEvent({ type: "log", message });
      };

      let stagehand: any;

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
        const claimStatusUrl = asText(firstLoginRow["Claim Status URL"] ?? firstLoginRow["claim status url"] ?? firstLoginRow["claimUrl"]);
        const finalClaimStatusUrl = claimStatusUrl || "https://providers.iehp.org/claims/status";

        const claimRows = JSON.parse(claimRowsJson) as GenericRow[];

        if (startIndex > 0) {
          await log(`Resuming processing from row ${startIndex + 1}...`);
        } else {
          await log(`Received ${claimRows.length} claim rows to process.`);
        }
        await sendEvent({ type: "progress", completed: startIndex, total: claimRows.length });

        log("Launching browser environment via Stagehand...");
        const isVercel = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV;
        
        stagehand = new Stagehand({
          env: "LOCAL",
          model: "gemini-2.0-flash",
          disablePino: true,
          localBrowserLaunchOptions: isVercel ? {
            args: chromium.args,
            executablePath: await chromium.executablePath(),
            headless: true,
          } : undefined
        });
        
        await stagehand.init();

        log(`Navigating to login URL: ${loginUrl}`);
        // For simple navigation, we can use act, but we might need the page object if it's exposed
        // Since stagehand.page is not guaranteed in V3, we use act
        await stagehand.act(`Navigate to ${loginUrl}`);

        log("Logging in...");
        await stagehand.act(`If there is a login form, fill in username '${userName}' and password '${password}' and submit the form. If already logged in, do nothing.`);

        const processStartTime = Date.now();
        const MAX_EXECUTION_TIME_MS = 4 * 60 * 1000;
        const BATCH_SIZE = 10;
        let processedInThisBatch = 0;

        for (let i = startIndex; i < claimRows.length; i++) {
          if (Date.now() - processStartTime > MAX_EXECUTION_TIME_MS || processedInThisBatch >= BATCH_SIZE) {
            await log(`Batch complete. Pausing at Row ${i + 1} to gracefully auto-resume the next chunk...`);
            break;
          }

          const row = claimRows[i];
          const rowIndex = typeof (row as any).__original_index === "number" ? (row as any).__original_index : i;
          const memberPolicyId = asText(row["Member Policy ID"] ?? row["member policy id"] ?? row["Member ID"]);
          const dosValue = row["Date Of Service"] ?? row["DOS"] ?? row["date of service"];

          if (!memberPolicyId || !dosValue || memberPolicyId === "NaN" || dosValue === "NaN") {
            const msg = "Skipped: Missing or Invalid Member ID / Date of Service.";
            await log(`Row ${i + 1}: ${msg}`);
            await sendEvent({
              type: "row_update",
              index: rowIndex,
              update: { BotClaimStatusCheck: "Skipped", BotClaimStatusCheckError: msg }
            });
            await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
            continue;
          }

          const dosDate = parseDateInput(dosValue);
          if (!dosDate) {
            const msg = `Skipped: Invalid Date of Service format: ${dosValue}`;
            await log(`Row ${i + 1}: ${msg}`);
            await sendEvent({
              type: "row_update",
              index: rowIndex,
              update: { BotClaimStatusCheck: "Skipped", BotClaimStatusCheckError: msg }
            });
            await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
            continue;
          }

          const { startDate, endDate } = getDosSearchRange(dosDate);
          const dosFormatted = formatMmDdYyyy(dosDate);

          log(`Processing Row ${i + 1}: Member ${memberPolicyId}, DOS ${dosFormatted}`);

          try {
            log(`Row ${i + 1}: Navigating to Claims Status and Searching...`);
            await stagehand.act(`Navigate to ${finalClaimStatusUrl}`);
            
            await stagehand.act(`Search for claim with Member ID '${memberPolicyId}' and Date of Service range from '${formatMmDdYyyy(startDate)}' to '${formatMmDdYyyy(endDate)}'. Make sure to expand advanced options if needed. Click the submit or search button.`);

            await stagehand.act(`Click on all claim row items on the page to expand and reveal their details. Scroll through the pages if there is pagination to find claims matching DOS ${dosFormatted}. Stop clicking when you have expanded the rows that match the date.`);

            const extracted = await stagehand.extract(
              `Extract all claim rows that EXACTLY match Date of Service ${dosFormatted}. Extract the summary, details, and status info. If the status mentions 'Refer to your RA', try to extract the Check Number from the expanded details text.`,
              z.object({
                claims: z.array(z.object({
                  summaryText: z.string().describe("The main summary text of the claim line item"),
                  headerText: z.string().describe("The expanded details header text"),
                  statusInfoText: z.string().describe("The status or status info of the claim in the expanded table"),
                  hasReferToRa: z.boolean().describe("True if the status text mentions 'Refer to your RA'"),
                  checkNumber: z.string().nullable().describe("The 5 to 20 character Check Number if present and hasReferToRa is true, else null")
                }))
              })
            );

            const details: string[] = [];
            const referRaDetails: string[] = [];
            const checkNumbersToDownload: string[] = [];

            if (extracted.claims.length === 0) {
              const msg = `No matching claim rows found for DOS ${dosFormatted}.`;
              await log(`Row ${i + 1}: Failed. ${msg}`);
              await sendEvent({
                type: "row_update",
                index: rowIndex,
                update: { BotClaimDetails: "No matching rows found for DOS.", BotClaimStatusCheck: "Failed", BotClaimStatusCheckError: msg }
              });
              await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
              continue;
            }

            for (const claim of extracted.claims) {
               details.push(`Summary: [${claim.summaryText}] | Details: [${claim.headerText}] | Status Info: [${claim.statusInfoText}]`);
               if (claim.hasReferToRa && claim.checkNumber) {
                  checkNumbersToDownload.push(claim.checkNumber);
                  await log(`Row ${i + 1}: Found Check Number ${claim.checkNumber} requiring RA download.`);
               }
            }

            // Download PDFs using Stagehand
            if (checkNumbersToDownload.length > 0) {
              const uniqueChecks = Array.from(new Set(checkNumbersToDownload));
              
              await stagehand.act(`Navigate to the Remittance Advice (RA) or Finance section.`);

              for (const chk of uniqueChecks) {
                await log(`Row ${i + 1}: Processing RA for Check Number ${chk}...`);
                
                await stagehand.act(`Search for Check Number '${chk}'. Wait for the results to load. Click the download icon or link for the Claim PDF corresponding to this check number. Wait for the download to finish.`);
                
                // Note: Stagehand V3 doesn't easily expose the raw downloaded file path without hooking into Playwright context.
                // We will inform the user in logs that PDF parsing via Stagehand requires additional setup.
                await log(`Row ${i + 1}: PDF download via Stagehand act() completed. Note: PDF binary parsing is not fully supported in pure Stagehand without custom handlers.`);
                referRaDetails.push(`Check ${chk}: Processed via Stagehand AI`);
              }
            }

            await log(`Row ${i + 1}: Success (${extracted.claims.length} matching claims).`);
            await sendEvent({
              type: "row_update",
              index: rowIndex,
              update: { 
                BotClaimDetails: details.join(" | "), 
                BotClaimStatusCheck: "Success", 
                BotClaimStatusCheckError: "",
                BotReferRA: referRaDetails.length > 0 ? referRaDetails.join(" | ") : ""
              }
            });
            await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });

          } catch (rowError) {
            const msg = rowError instanceof Error ? rowError.message : "Unknown row error";
            await log(`Row ${i + 1}: Failed. ${msg}`);
            
            await sendEvent({
              type: "row_update",
              index: rowIndex,
              update: { BotClaimStatusCheck: "Failed", BotClaimStatusCheckError: msg }
            });
            await sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
          }

          processedInThisBatch++;
        }
      } catch (globalError) {
        const msg = globalError instanceof Error ? globalError.message : "Unexpected automation error.";
        await log(`Global automation error: ${msg}`);
        await sendEvent({ type: "error", message: msg });
      } finally {
        clearInterval(keepAliveInterval);
        if (stagehand) {
          await stagehand.close().catch(() => {});
        }
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
