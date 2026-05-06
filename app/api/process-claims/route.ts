import { chromium } from "playwright";
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

    const firstLogin = loginRows[0];
    const username = pickValue(firstLogin, ["username", "Username", "userName", "UserName"]);
    const password = pickValue(firstLogin, ["password", "Password"]);
    const loginUrl = pickValue(firstLogin, ["loginUrl", "LoginUrl", "url", "URL"]) ||
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

    const browser = await chromium.launch({
      channel: "chrome",
      headless: true,
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      logs.push(`Navigating to login URL: ${loginUrl}`);
      await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      const usernameInput = page.locator("input[type='email'], input[name*='user'], input[id*='user']").first();
      const passwordInput = page.locator("input[type='password']").first();
      const submitButton = page.locator("button[type='submit'], input[type='submit']").first();

      await usernameInput.fill(username);
      await passwordInput.fill(password);
      await submitButton.click();

      await page.waitForLoadState("networkidle", { timeout: 60000 });
      await page.goto("https://providers.iehp.org/claims/status", {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });

      for (const row of claimRows) {
        const nowText = new Date().toISOString();
        row.BotClaimStatusCheckTime = nowText;
        row.BotClaimStatusCheck = "Failed";
        row.BotClaimDetails = "";
        row.BotClaimStatusCheckError = "";

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

          await page.locator("input[id*='member'], input[name*='member'], input[type='text']").first().fill(memberPolicyId);
          await page.getByRole("button", { name: /more options/i }).click();
          await page.getByText(/search by dos/i).click();
          await page.locator("input[id*='start'], input[name*='start']").first().fill(formatMmDdYyyy(startDate));
          await page.locator("input[id*='end'], input[name*='end']").first().fill(formatMmDdYyyy(endDate));
          await page.getByRole("button", { name: /^search$/i }).first().click();

          await page.waitForLoadState("networkidle", { timeout: 30000 });

          const matchingRows = page.locator("table tr", {
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
            const rowText = (await matchingRows.nth(index).innerText()).replace(/\s+/g, " ").trim();
            details.push(rowText);
          }

          row.BotClaimDetails = details.join(" | ");
          row.BotClaimStatusCheck = "Success";
          row.BotClaimStatusCheckError = "";
          logs.push(`Processed member ${memberPolicyId}: ${count} matching rows.`);
        } catch (rowError) {
          row.BotClaimStatusCheck = "Failed";
          row.BotClaimStatusCheckError = rowError instanceof Error ? rowError.message : "Unknown row error";
          logs.push(`Row failed: ${row.BotClaimStatusCheckError}`);
        }
      }
    } finally {
      await page.close();
      await context.close();
      await browser.close();
    }

    const updatedSheet = XLSX.utils.json_to_sheet(claimRows);
    claimWorkbook.Sheets[claimSheetName] = updatedSheet;
    const outputBuffer = XLSX.write(claimWorkbook, { type: "buffer", bookType: "xlsx" });

    const outputFileName = `updated-claims-${startedAt.toISOString().replace(/[:.]/g, "-")}.xlsx`;

    return Response.json({
      success: true,
      message: `Processing completed for ${claimRows.length} rows.`,
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
