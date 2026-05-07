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
export async function POST(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const sendEvent = (data: any) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      };

      const log = (message: string) => {
        sendEvent({ type: "log", message });
      };

      try {
        const formData = await req.formData();
        const loginExcelFile = formData.get("loginExcel") as File | null;
        const claimRowsJson = formData.get("claimRows") as string | null;

        if (!loginExcelFile || !(loginExcelFile instanceof File) || !claimRowsJson) {
          sendEvent({ type: "error", message: "Missing login Excel file or claim rows." });
          controller.close();
          return;
        }

        const loginArrayBuffer = await loginExcelFile.arrayBuffer();
        const loginWorkbook = XLSX.read(loginArrayBuffer, { type: "array" });
        const loginSheetName = loginWorkbook.SheetNames[0];
        const loginSheet = loginWorkbook.Sheets[loginSheetName];
        const loginRows = XLSX.utils.sheet_to_json(loginSheet) as GenericRow[];

        if (loginRows.length === 0) {
          sendEvent({ type: "error", message: "Login Excel file is empty." });
          controller.close();
          return;
        }

        const firstLoginRow = loginRows[0];
        const rawUrl = asText(firstLoginRow["URL"] ?? firstLoginRow["url"]);
        const userName = asText(firstLoginRow["User Name"] ?? firstLoginRow["user name"] ?? firstLoginRow["username"]);
        const password = asText(firstLoginRow["Password"] ?? firstLoginRow["password"]);

        if (!rawUrl || !userName || !password) {
          sendEvent({ type: "error", message: "Invalid login credentials format." });
          controller.close();
          return;
        }

        const loginUrl = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
        const claimRows = JSON.parse(claimRowsJson) as GenericRow[];

        log(`Received ${claimRows.length} claim rows to process.`);
        sendEvent({ type: "progress", completed: 0, total: claimRows.length });

        log("Launching browser environment...");
        const isVercel = process.env.VERCEL === "1" || !!process.env.VERCEL_ENV;
        const USE_CHROME_PROFILE = false;

        let browser;
        let context: BrowserContext;
        let page: Page;

        try {
          if (isVercel) {
            log("Attempting @sparticuz/chromium browser launch for Vercel.");
            browser = await playwright.launch({
              args: chromium.args,
              executablePath: await chromium.executablePath(),
              headless: chromium.headless,
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

          if (!browser) {
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
            await page.waitForNavigation({ waitUntil: "networkidle", timeout: 60000 }).catch(() => log("waitForNavigation timeout, continuing..."));
            
            try {
              await loggedInIndicator.waitFor({ state: "visible", timeout: 15000 });
              log("Login successful.");
            } catch {
              throw new Error("Failed to verify login success. Check credentials or site structure.");
            }
          }

          for (let i = 0; i < claimRows.length; i++) {
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
            startDate.setDate(dosDate.getDate() - 15);
            const endDate = new Date(dosDate);
            endDate.setDate(dosDate.getDate() + 15);

            log(`Processing Row ${i + 1}: Member ${memberPolicyId}, DOS ${formatMmDdYyyy(dosDate)}`);

            try {
              log(`Row ${i + 1}: Navigating to Claims Status...`);
              await page.goto("https://providers.iehp.org/claims-status", {
                waitUntil: "networkidle",
                timeout: 60000,
              });

              await page.locator("input[name='expressionBox']:visible").first().fill(memberPolicyId);
              await page.locator("div.advanced-search:has-text('Options'):visible").click();
              await page.getByText(/search by dos/i).click();
              await page.locator("input.min-range:visible, input[ng-model='search.minRange']:visible").first().fill(formatMmDdYyyy(startDate));
              await page.locator("input.max-range:visible, input[ng-model='search.maxRange']:visible").first().fill(formatMmDdYyyy(endDate));
              await page.locator("button.singleSearchButton:visible, button[ng-click='search.submit()']:visible").first().click();

              await page.locator('div[full-screen-ajax-loader] .full-screen-bg').waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
              await page.waitForLoadState("networkidle", { timeout: 30000 });

              const matchingRows = page.locator("tr.line-item", {
                hasText: formatMmDdYyyy(dosDate),
              });

              const count = await matchingRows.count();
              if (count === 0) {
                const msg = "No matching claim rows on website.";
                log(`Row ${i + 1}: Failed. ${msg}`);
                sendEvent({
                  type: "row_update",
                  index: i,
                  update: { BotClaimDetails: "No matching rows found for DOS.", BotClaimStatusCheck: "Failed", BotClaimStatusCheckError: msg }
                });
                sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
                continue;
              }

              const details: string[] = [];
              for (let index = 0; index < count; index += 1) {
                const currentLineItem = matchingRows.nth(index);
                const summaryText = (await currentLineItem.innerText()).replace(/\s+/g, " ").trim();
                
                await currentLineItem.click();
                const detailsRow = page.locator(`tr.line-item:has-text("${formatMmDdYyyy(dosDate)}") ~ tr.details`).nth(index);
                const detailsContent = detailsRow.locator('.details-content');
                
                await detailsContent.waitFor({ state: "visible", timeout: 10000 });
                const headerText = await detailsContent.locator('.details-header').innerText();
                const tableText = await detailsContent.locator('table.table-condensed').innerText();
                
                const fullDetails = `Summary: [${summaryText}] | Details: [${headerText.replace(/\s+/g, " ")}] | Status Info: [${tableText.replace(/\s+/g, " ")}]`;
                details.push(fullDetails);
              }

              log(`Row ${i + 1}: Success (${count} matching rows).`);
              sendEvent({
                type: "row_update",
                index: i,
                update: { BotClaimDetails: details.join(" | "), BotClaimStatusCheck: "Success", BotClaimStatusCheckError: "" }
              });
              sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
            } catch (rowError) {
              const msg = rowError instanceof Error ? rowError.message : "Unknown row error";
              log(`Row ${i + 1}: Failed. ${msg}`);
              sendEvent({
                type: "row_update",
                index: i,
                update: { BotClaimStatusCheck: "Failed", BotClaimStatusCheckError: msg }
              });
              sendEvent({ type: "progress", completed: i + 1, total: claimRows.length });
            }
          }
        } finally {
          await page?.close().catch(() => {});
          await context?.close().catch(() => {});
          await browser?.close().catch(() => {});
        }
      } catch (globalError) {
        const msg = globalError instanceof Error ? globalError.message : "Unexpected automation error.";
        log(`Global automation error: ${msg}`);
        sendEvent({ type: "error", message: msg });
      } finally {
        sendEvent({ type: "done" });
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });
}
