import os from "node:os";
import path from "node:path";
import chromium from "@sparticuz/chromium";
import { chromium as playwright, type BrowserContext, type Page } from "playwright-core";
import * as XLSX from "xlsx";

type GenericRow = Record<string, unknown>;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const year = date.getFullYear();
  return `${month}/${day}/${year}`;
}

function pickValue(row: GenericRow, keys: string[]): string {
  for (const key of keys) {
    if (key in row) {
      const value = asText(row[key]);
      if (value) {
        return value;
      }
    }
  }
  return "";
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function pickValueByAliases(row: GenericRow, aliases: string[]): string {
  const aliasSet = new Set(aliases.map(normalizeKey));
  for (const [key, value] of Object.entries(row)) {
    if (aliasSet.has(normalizeKey(key))) {
      const text = asText(value);
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function shouldUsePersistentProfile(): boolean {
  const value = process.env.USE_CHROME_PROFILE;
  if (!value) {
    return false;
  }
  return ["1", "true", "yes"].includes(value.toLowerCase());
}

async function launchAutomationContext(
  logs: string[],
): Promise<{ context: BrowserContext; page: Page }> {
  if (shouldUsePersistentProfile()) {
    const userDataDir = process.env.CHROME_USER_DATA_DIR ||
      path.join(os.homedir(), "Library/Application Support/Google/Chrome");
    logs.push(`Attempting persistent Chrome profile launch: ${userDataDir}`);
    try {
      const context = await playwright.launchPersistentContext(userDataDir, {
        channel: "chrome",
        headless: false,
        ignoreDefaultArgs: ["--disable-extensions"],
      });
      const page = context.pages()[0] ?? await context.newPage();
      return { context, page };
    } catch (profileError) {
      const message = profileError instanceof Error ? profileError.message : String(profileError);
      logs.push(`Persistent profile launch failed, falling back: ${message}`);
    }
  }

  try {
    const isLocal = process.env.NODE_ENV === "development" || !process.env.VERCEL;
    
    if (isLocal) {
      logs.push("Attempting local browser launch.");
      try {
        const browser = await playwright.launch({
          channel: "chrome",
          headless: true,
        });
        const context = await browser.newContext();
        const page = await context.newPage();
        return { context, page };
      } catch (localError) {
        logs.push(`Local chrome launch failed: ${localError instanceof Error ? localError.message : String(localError)}`);
      }
    }

    logs.push("Attempting @sparticuz/chromium browser launch for Vercel.");
    const executablePath = await chromium.executablePath();
    const browser = await playwright.launch({
      args: chromium.args,
      executablePath: executablePath || undefined,
      headless: true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    return { context, page };
  } catch (chromeError) {
    const message = chromeError instanceof Error ? chromeError.message : String(chromeError);
    logs.push(`Browser launch failed: ${message}`);
    throw new Error(`Browser launch failed: ${message}`);
  }
}

export async function POST(request: Request): Promise<Response> {
  const logs: string[] = [];
  const startedAt = new Date();

  try {
    const formData = await request.formData();
    const loginExcel = formData.get("loginExcel");
    const claimExcel = formData.get("claimExcel");

    if (!(loginExcel instanceof File) || !(claimExcel instanceof File)) {
      return Response.json(
        {
          success: false,
          message: "Both login and claim files are required.",
        },
        { status: 400 },
      );
    }

    const loginBuffer = Buffer.from(await loginExcel.arrayBuffer());
    const claimBuffer = Buffer.from(await claimExcel.arrayBuffer());
    const loginWorkbook = XLSX.read(loginBuffer, { type: "buffer" });
    const claimWorkbook = XLSX.read(claimBuffer, { type: "buffer", cellDates: true });

    const loginSheet = loginWorkbook.Sheets[loginWorkbook.SheetNames[0]];
    const claimSheetName = claimWorkbook.SheetNames[0];
    const claimSheet = claimWorkbook.Sheets[claimSheetName];

    const loginRows = XLSX.utils.sheet_to_json<GenericRow>(loginSheet, { defval: "" });
    const claimRows = XLSX.utils.sheet_to_json<GenericRow>(claimSheet, { defval: "" });

    if (loginRows.length === 0) {
      return Response.json(
        { success: false, message: "Login Excel has no rows." },
        { status: 400 },
      );
    }

    const loginRow = loginRows.find((row) => {
      const usernameCandidate = pickValueByAliases(row, [
        "username",
        "user name",
        "userid",
        "user id",
        "email",
      ]);
      const passwordCandidate = pickValueByAliases(row, ["password", "passcode", "pwd"]);
      return Boolean(usernameCandidate && passwordCandidate);
    }) ?? loginRows[0];

    const username = pickValueByAliases(loginRow, [
      "username",
      "user name",
      "userid",
      "user id",
      "email",
    ]);
    const password = pickValueByAliases(loginRow, ["password", "passcode", "pwd"]);
    const loginUrl = pickValueByAliases(loginRow, ["loginurl", "url", "website", "site"]) ||
      pickValue(loginRow, ["loginUrl", "LoginUrl", "url", "URL"]) ||
      "https://providers.iehp.org/account/login";

    if (!username || !password) {
      return Response.json(
        {
          success: false,
          message: "Could not find username/password in login Excel first row.",
        },
        { status: 400 },
      );
    }

    logs.push(`Loaded ${claimRows.length} claim rows.`);
    for (const row of claimRows) {
      row.BotClaimStatusCheckTime = new Date().toISOString();
      row.BotClaimStatusCheck = "Failed";
      row.BotClaimDetails = "";
      row.BotClaimStatusCheckError = "";
    }

    let globalAutomationError = "";

    try {
      const { context, page } = await launchAutomationContext(logs);

      try {
        logs.push(`Navigating to login URL: ${loginUrl}`);
        await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

        const usernameInput = page
          .locator("input[type='email']:visible, input[name*='user']:visible, input[id*='user']:visible")
          .first();
        const passwordInput = page.locator("input[type='password']:visible").first();
        const submitButton = page
          .locator("button[type='submit']:visible, input[type='submit']:visible")
          .first();

        await usernameInput.fill(username);
        await passwordInput.fill(password);
        await submitButton.click();

        await page.waitForLoadState("networkidle", { timeout: 60000 });
        await page.goto("https://providers.iehp.org/claims/status", {
          waitUntil: "domcontentloaded",
          timeout: 60000,
        });

        for (const row of claimRows) {
          row.BotClaimStatusCheckTime = new Date().toISOString();

          try {
          const memberPolicyId = pickValue(row, [
            "Member Policy ID",
            "MemberPolicyID",
            "Member ID",
            "memberPolicyId",
          ]);
          const dosRaw = row.DOS ?? row.DateOfService ?? row.dateOfService ?? row["Date of Service"];
          const dosDate = parseDateInput(dosRaw);

          if (!memberPolicyId) {
            throw new Error("Missing Member Policy ID in row.");
          }
          if (!dosDate) {
            throw new Error("Missing or invalid DOS in row.");
          }

          const startDate = new Date(dosDate);
          const endDate = new Date(dosDate);
          startDate.setDate(startDate.getDate() - 1);
          endDate.setDate(endDate.getDate() + 1);

          await page.goto("https://providers.iehp.org/claims/status", {
            waitUntil: "domcontentloaded",
            timeout: 60000,
          });

          // 1. IEHP ID Input (ng-model="model.input" or name="expressionBox")
          await page.locator("input[name='expressionBox']:visible").first().fill(memberPolicyId);
          
          // 2. Options "button" (It is a div, not a button!)
          await page.locator("div.advanced-search:has-text('Options'):visible").click();
          
          // 3. Search by DOS Checkbox/Label
          await page.getByText(/search by dos/i).click();
          
          // 4. Start Date (ng-model="search.minRange" or class="min-range")
          await page.locator("input.min-range:visible, input[ng-model='search.minRange']:visible").first().fill(formatMmDdYyyy(startDate));
          
          // 5. End Date (ng-model="search.maxRange" or class="max-range")
          await page.locator("input.max-range:visible, input[ng-model='search.maxRange']:visible").first().fill(formatMmDdYyyy(endDate));
          
          // 6. Search Button (ng-click="search.submit()")
          await page.locator("button.singleSearchButton:visible, button[ng-click='search.submit()']:visible").first().click();

          // Explicitly wait for the Angular full-screen loader to finish and disappear
          await page.locator('div[full-screen-ajax-loader] .full-screen-bg').waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});

          await page.waitForLoadState("networkidle", { timeout: 30000 });

          const matchingRows = page.locator("tr.line-item", {
            hasText: formatMmDdYyyy(dosDate),
          });

          const count = await matchingRows.count();
          if (count === 0) {
            row.BotClaimDetails = "No matching rows found for DOS.";
            row.BotClaimStatusCheck = "Failed";
            row.BotClaimStatusCheckError = "No matching claim rows on website.";
            logs.push(`No match for member ${memberPolicyId} DOS ${formatMmDdYyyy(dosDate)}.`);
            continue;
          }

          const details: string[] = [];
          for (let index = 0; index < count; index += 1) {
            const currentLineItem = matchingRows.nth(index);
            
            // 1. Extract the high-level summary from the row before clicking
            const summaryText = (await currentLineItem.innerText()).replace(/\s+/g, " ").trim();
            
            // 2. Click the row to expand the details pane
            await currentLineItem.click();
            
            // 3. The details row is the very next <tr> after the line-item <tr>
            // We find it using an adjacent sibling selector
            const detailsRow = page.locator(`tr.line-item:has-text("${formatMmDdYyyy(dosDate)}") ~ tr.details`).nth(index);
            const detailsContent = detailsRow.locator('.details-content');
            
            // Wait for the details content to become visible
            await detailsContent.waitFor({ state: "visible", timeout: 10000 });
            
            // 4. Extract specific values from the details content
            // We extract all the definition list text (Claim #, Check #, etc)
            const headerText = await detailsContent.locator('.details-header').innerText();
            
            // We extract the line item table text (Procedure, Billed, Status)
            const tableText = await detailsContent.locator('table.table-condensed').innerText();
            
            const fullDetails = `Summary: [${summaryText}] | Details: [${headerText.replace(/\s+/g, " ")}] | Status Info: [${tableText.replace(/\s+/g, " ")}]`;
            details.push(fullDetails);
          }

          row.BotClaimDetails = details.join(" | ");
          row.BotClaimStatusCheck = "Success";
          row.BotClaimStatusCheckError = "";
          logs.push(`Processed member ${memberPolicyId}: ${count} matching rows.`);
          } catch (rowError) {
            row.BotClaimStatusCheck = "Failed";
            row.BotClaimStatusCheckError = rowError instanceof Error
              ? rowError.message
              : "Unknown row error";
            logs.push(`Row failed: ${row.BotClaimStatusCheckError}`);
          }
        }
      } finally {
        await page.close();
        await context.close();
      }
    } catch (automationError) {
      globalAutomationError = automationError instanceof Error
        ? automationError.message
        : "Unexpected automation error.";
      logs.push(`Global automation error: ${globalAutomationError}`);
      for (const row of claimRows) {
        row.BotClaimStatusCheck = "Failed";
        if (!asText(row.BotClaimStatusCheckError)) {
          row.BotClaimStatusCheckError = globalAutomationError;
        }
      }
    }

    const updatedSheet = XLSX.utils.json_to_sheet(claimRows);
    claimWorkbook.Sheets[claimSheetName] = updatedSheet;
    const outputBuffer = XLSX.write(claimWorkbook, { type: "buffer", bookType: "xlsx" });

    const outputFileName = `updated-claims-${startedAt.toISOString().replace(/[:.]/g, "-")}.xlsx`;

    return Response.json({
      success: !globalAutomationError,
      message: globalAutomationError
        ? `Processing completed with errors for ${claimRows.length} rows.`
        : `Processing completed for ${claimRows.length} rows.`,
      processedRows: claimRows.length,
      outputFileName,
      outputFileBase64: outputBuffer.toString("base64"),
      logs,
    });
  } catch (error) {
    return Response.json(
      {
        success: false,
        message: error instanceof Error ? error.message : "Unexpected processing error.",
        logs,
      },
      { status: 500 },
    );
  }
}
