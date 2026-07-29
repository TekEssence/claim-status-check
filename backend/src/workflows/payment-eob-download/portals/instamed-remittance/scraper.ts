import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import type { AutomationContext, AutomationRunner } from "../../../types";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { getJobDataPath } from "@/backend/src/core/storage";
import type {
  PaymentEobComparisonRow,
  PaymentEobCredentials,
  PaymentEobPortalRecord,
  PaymentEobReferenceRow,
  PaymentEobRunInput,
} from "../../types";
import { normalizeCheckNumber } from "../availity-remittance/input";
import { createPaymentEobResultWorkbookBuffer } from "../availity-remittance/output-builder";
import { uploadPaymentEobOutputToSharePoint } from "../availity-remittance/sharepoint";
import { createStoredZipFromFolder } from "../availity-remittance/zip";
import { instamedRemittanceConfig } from "./config";
import { readInstamedRemittanceCredentials, readReferenceRows } from "./input";

type RunInput = {
  credentials: PaymentEobCredentials;
  referenceRows: PaymentEobReferenceRow[];
};

const REMITTANCE_URL = "https://online.instamed.com/providers/Form/Healthcare/RemittanceSearch";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

function downloadableFileEvent(filename: string, buffer: Buffer, mimeType: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: buffer.toString("base64"),
    mimeType,
  };
}

function todayYyyyMmDd(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function safeFilePart(value: string): string {
  return value.replace(/[<>:"/\\|?*]/g, "_");
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim())) rows.push(row);

  const headers = rows.shift()?.map((header) => header.trim()) ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])));
}

function findValue(row: Record<string, string>, aliases: string[]): string {
  const normalized = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]+/g, ""), value]));
  for (const alias of aliases) {
    const value = normalized.get(alias.toLowerCase().replace(/[^a-z0-9]+/g, ""));
    if (value) return value.trim();
  }
  return "";
}

function portalRecordFromCsv(row: Record<string, string>): PaymentEobPortalRecord | null {
  if (/^totals:?$/i.test(Object.values(row)[0] ?? "")) return null;
  const checkNumber = normalizeCheckNumber(findValue(row, ["Check / EFT Trace #", "Check/EFT Trace #", "Check EFT Trace #", "Check/EFT #"]));
  if (!checkNumber) return null;
  return {
    checkNumber,
    checkDate: findValue(row, ["Payment Date", "Check / EFT Date", "Check/EFT Date"]),
    payer: findValue(row, ["Payer Name", "Payer"]),
    payee: findValue(row, ["Payee Name", "Payee"]),
    receivedByAvaility: findValue(row, ["Workflow Status"]),
    amount: findValue(row, ["Paid Amount", "Total Payment", "Payment Amount"]),
    raw: row,
  };
}

export function parseInstamedRemittanceCsv(text: string): PaymentEobPortalRecord[] {
  return parseCsv(text).map(portalRecordFromCsv).filter((record): record is PaymentEobPortalRecord => Boolean(record));
}

async function clickButtonByText(page: Page, text: string): Promise<void> {
  await page.locator("a,button").filter({ hasText: new RegExp(`^\\s*${text}\\s*$`, "i") }).first().click({ timeout: 30000 });
}

async function selectExtComboOption(page: Page, input: Locator, optionText: string): Promise<void> {
  await input.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  const inputId = await input.getAttribute("id").catch(() => null);
  const triggerWrap = inputId ? page.locator(`#${inputId.replace(/-inputEl$/, "-triggerWrap")}`) : input;
  const trigger = inputId ? page.locator(`#${inputId.replace(/-inputEl$/, "-triggerWrap")} .x-form-trigger`).first() : input;

  if (await input.isVisible({ timeout: 3000 }).catch(() => false)) {
    await input.click({ timeout: 15000 }).catch(async () => {
      await trigger.click({ timeout: 10000, force: true }).catch(async () => {
        await triggerWrap.click({ timeout: 10000, force: true });
      });
    });
  } else {
    await trigger.click({ timeout: 10000, force: true }).catch(async () => {
      await triggerWrap.click({ timeout: 10000, force: true });
    });
  }

  await input.press("Control+A").catch(() => {});
  await input.fill(optionText).catch(() => {});
  const option = page.locator(".x-boundlist-item, [role='option'], li").filter({ hasText: optionText }).first();
  if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
    await option.click({ timeout: 10000 });
  } else {
    await input.press("Enter").catch(() => {});
  }
}

function firstInputAfterText(page: Page, labelText: string, role: "combobox" | "checkbox"): Locator {
  return page.locator(`xpath=//*[normalize-space()="${labelText}"]/following::input[@role="${role}"][1]`).first();
}

async function clickRemittanceSearch(page: Page, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Clicking InstaMed Remittance Search.", eventName: "payment_eob_instamed_search_click" });
  await page.locator("#MyFormPanel-button-Search").click({ timeout: 30000 });
}

async function login(page: Page, credentials: PaymentEobCredentials, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Opening InstaMed login page.", eventName: "payment_eob_instamed_login_open" });
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("#MyFormPanel-UserID-inputEl, input[name='UserID']").fill(credentials.username);
  await page.locator("#MyFormPanel-Password-inputEl, input[name='Password']").fill(credentials.password);
  await page.locator("#MyFormPanel-txtCorporateID-inputEl, input[name='txtCorporateID']").fill(credentials.corporateId ?? "");
  await clickButtonByText(page, "Log In");
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  const verificationInput = page.locator("#MyFormPanel-VerificationCode-inputEl, input[name='VerificationCode']").first();
  if (await verificationInput.isVisible({ timeout: 15000 }).catch(() => false)) {
    await context.log({
      level: "warn",
      message: "InstaMed two-step verification is required. Enter the texted verification code in the browser and click Next; the job will continue after login completes.",
      eventName: "payment_eob_instamed_mfa_required",
    });
    await page.waitForURL(/\/providers\/Form\/(Insight\/Payment|Healthcare\/RemittanceSearch|Home)/i, { timeout: 180000 });
  }

  await context.log({ level: "info", message: "InstaMed login completed.", eventName: "payment_eob_instamed_login_complete" });
}

async function openRemittanceSearch(page: Page, context: AutomationContext): Promise<void> {
  await page.goto(REMITTANCE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.locator("#MyFormPanel-RemittanceSimpleSearchValue-inputEl, input[name='RemittanceSimpleSearchValue']").waitFor({ state: "visible", timeout: 60000 });
  await context.log({ level: "info", message: "InstaMed Remittance Search opened.", eventName: "payment_eob_instamed_remittance_opened" });
}

async function ensureRemittanceSearchPage(page: Page, context: AutomationContext): Promise<void> {
  const searchInput = page.locator("#MyFormPanel-RemittanceSimpleSearchValue-inputEl:visible, input[name='RemittanceSimpleSearchValue']:visible").first();
  if (await searchInput.isVisible({ timeout: 3000 }).catch(() => false)) return;
  await context.log({
    level: "info",
    message: "Returning to InstaMed Remittance Search before the next trace search.",
    eventName: "payment_eob_instamed_return_to_search",
  });
  await openRemittanceSearch(page, context);
}

async function waitForSearchSettled(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await Promise.race([
    page.getByText(/No results found/i).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined),
    page.getByText(/Payment Search Results/i).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined),
  ]);
}

async function downloadPortalCsv(page: Page, context: AutomationContext, outputFolder: string): Promise<PaymentEobPortalRecord[]> {
  await page.locator("#MyFormPanel-RemittanceSimpleSearchValue-inputEl, input[name='RemittanceSimpleSearchValue']").fill("");
  await selectExtComboOption(page, page.locator("#MyFormPanel-QuickSearchDateType-inputEl:visible, input[name='QuickSearchDateType']:visible").first(), "LAST 7 DAYS");
  await clickRemittanceSearch(page, context);
  await waitForSearchSettled(page);

  if (await page.getByText(/No results found/i).first().isVisible().catch(() => false)) {
    await context.log({ level: "info", message: "InstaMed returned No results found for Last 7 Days.", eventName: "payment_eob_instamed_no_results" });
    return [];
  }

  const selectAll = firstInputAfterText(page, "Payment Search Results > 9 Results", "checkbox")
    .or(firstInputAfterText(page, "Payment Search Results > 1 Result", "checkbox"))
    .or(page.locator("input[role='checkbox']:visible").first())
    .or(page.locator("xpath=//*[contains(normalize-space(), 'Payment Search Results')]/following::input[@role='checkbox'][1]").first());
  await selectAll.click({ timeout: 15000 }).catch(() => {});
  await selectExtComboOption(page, page.locator("#PaymentsRemittanceSimpleSearchResultsView-ExportFormat-inputEl:visible, input[name='ExportFormat']:visible").first(), "Comma Delimited (.csv)");

  const csvDownloadPromise = page.waitForEvent("download", { timeout: 90000 });
  await clickButtonByText(page, "Download");
  const csvDownload = await csvDownloadPromise;
  const csvPath = path.join(outputFolder, "instamed_portal_remittance_results.csv");
  await csvDownload.saveAs(csvPath);
  const csvText = await fs.readFile(csvPath, "utf8");
  await context.emit(downloadableFileEvent("instamed_portal_remittance_results.csv", Buffer.from(csvText, "utf8"), "text/csv"));
  await context.log({ level: "info", message: `Downloaded InstaMed portal CSV to ${csvPath}.`, eventName: "payment_eob_instamed_csv_downloaded" });
  return parseInstamedRemittanceCsv(csvText);
}

async function searchOnePayment(page: Page, checkNumber: string, context: AutomationContext): Promise<boolean> {
  await ensureRemittanceSearchPage(page, context);
  const searchInput = page.locator("#MyFormPanel-RemittanceSimpleSearchValue-inputEl:visible, input[name='RemittanceSimpleSearchValue']:visible").first();
  await searchInput.click();
  await searchInput.press("Control+A");
  await searchInput.fill(checkNumber);
  await selectExtComboOption(page, page.locator("#MyFormPanel-QuickSearchDateType-inputEl:visible, input[name='QuickSearchDateType']:visible").first(), "LAST 7 DAYS");
  await clickRemittanceSearch(page, context);
  await waitForSearchSettled(page);
  return !(await page.getByText(/No results found/i).first().isVisible().catch(() => false));
}

async function openSummary(page: Page): Promise<void> {
  const rowSummaryLink = page
    .locator('a.detail_action_link:visible[onclick*="PaymentsQuickSearchController.viewBatchSummary"]')
    .filter({ hasText: /^Summary$/i })
    .first();
  await rowSummaryLink.scrollIntoViewIfNeeded({ timeout: 15000 }).catch(() => {});
  await rowSummaryLink.click({ timeout: 30000 });
  await page.getByText("Payment Remittance Response", { exact: true }).waitFor({ state: "visible", timeout: 60000 });
}

async function downloadEdiFromSummary(page: Page, outputFolder: string, record: PaymentEobPortalRecord): Promise<string> {
  await page.locator("a,button").filter({ hasText: /^EDI$/i }).first().click({ timeout: 30000 });
  const downloadPromise = page.waitForEvent("download", { timeout: 90000 });
  await page.locator("a,button").filter({ hasText: /^Download$/i }).last().click({ timeout: 30000 });
  const download = await downloadPromise;
  const suggested = download.suggestedFilename();
  const extension = path.extname(suggested) || ".txt";
  const filename = `${safeFilePart(record.checkNumber)}${extension}`;
  await download.saveAs(path.join(outputFolder, filename));
  await page.locator("a,button").filter({ hasText: /^Close$/i }).first().click({ timeout: 10000 }).catch(async () => {
    await page.keyboard.press("Escape").catch(() => {});
  });
  return filename;
}

async function emitRunZip(outputRoot: string, context: AutomationContext): Promise<void> {
  const datePart = todayYyyyMmDd();
  const runFolder = "run-01";
  const zipRootName = `PaymentEobDownloads/${datePart}/${runFolder}`;
  const zipBuffer = await createStoredZipFromFolder(outputRoot, zipRootName);
  const zipFilename = `InstamedPaymentEobDownloads_${datePart}_${runFolder}.zip`;
  await context.emit(downloadableFileEvent(zipFilename, zipBuffer, "application/zip"));
}

async function uploadToSharePointIfEnabled(credentials: PaymentEobCredentials, outputRoot: string, context: AutomationContext): Promise<void> {
  if (process.env.PAYMENT_EOB_SHAREPOINT_UPLOAD_ENABLED !== "true") return;
  await uploadPaymentEobOutputToSharePoint(credentials, outputRoot, context);
}

export async function runInstamedRemittanceJob(input: RunInput, context: AutomationContext): Promise<void> {
  const outputRoot = path.join(getJobDataPath(context.jobId, "outputs"), `instamed-remittance-${context.jobId}`);
  const outputEdiFolder = path.join(outputRoot, "EDI");
  await fs.mkdir(outputEdiFolder, { recursive: true });

  const referenceNumbers = new Set(input.referenceRows.map((row) => row.checkNumber));
  const comparisonRows: PaymentEobComparisonRow[] = [];
  let session: Awaited<ReturnType<typeof launchAutomationBrowser>> | null = null;
  let page: Page | null = null;

  await context.emit({ type: "progress", completed: 0, total: 1 });
  try {
    session = await launchAutomationBrowser();
    page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(Number(process.env.PORTAL_INSTAMED_REMITTANCE_TIMEOUT_MS || 30000));
    page.setDefaultNavigationTimeout(Number(process.env.PORTAL_INSTAMED_REMITTANCE_NAVIGATION_TIMEOUT_MS || 60000));

    await login(page, input.credentials, context);
    await openRemittanceSearch(page, context);
    const portalRecords = await downloadPortalCsv(page, context, outputRoot);
    const uniqueRecords = portalRecords.filter((record) => {
      if (referenceNumbers.has(record.checkNumber)) {
        comparisonRows.push({
          checkNumber: record.checkNumber,
          checkDate: record.checkDate,
          comparison: "Existing",
          searchResult: "Skipped",
          pdfStatus: "Skipped",
          filename: "",
          message: "Found in uploaded Excel",
        });
        return false;
      }
      return true;
    });

    await context.emit({ type: "progress", completed: 0, total: Math.max(uniqueRecords.length, 1) });
    for (let index = 0; index < uniqueRecords.length; index += 1) {
      const record = uniqueRecords[index];
      if (context.isCancelled?.()) {
        await context.emit({ type: "cancelled", message: "InstaMed Payment EOB download cancelled." });
        break;
      }
      try {
        await context.log({ level: "info", message: `Searching unmatched Check/EFT Trace ${record.checkNumber}.`, eventName: "payment_eob_instamed_edi_search" });
        const found = await searchOnePayment(page, record.checkNumber, context);
        if (!found) {
          comparisonRows.push({
            checkNumber: record.checkNumber,
            checkDate: record.checkDate,
            comparison: "Unique",
            searchResult: "Not found",
            pdfStatus: "Not downloaded",
            filename: "",
            message: "No results found",
          });
        } else {
          await openSummary(page);
          const filename = await downloadEdiFromSummary(page, outputEdiFolder, record);
          comparisonRows.push({
            checkNumber: record.checkNumber,
            checkDate: record.checkDate,
            comparison: "Unique",
            searchResult: "Found",
            pdfStatus: "Downloaded",
            filename,
            message: "Downloaded EDI from InstaMed summary.",
          });
        }
      } catch (error) {
        comparisonRows.push({
          checkNumber: record.checkNumber,
          checkDate: record.checkDate,
          comparison: "Unique",
          searchResult: "Error",
          pdfStatus: "Error",
          filename: "",
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await context.emit({ type: "progress", completed: index + 1, total: Math.max(uniqueRecords.length, 1) });
    }

    if (!portalRecords.length) {
      for (const row of input.referenceRows) {
        comparisonRows.push({
          checkNumber: row.checkNumber,
          checkDate: row.checkDate || "",
          comparison: "Existing",
          searchResult: "Skipped",
          pdfStatus: "Skipped",
          filename: "",
          message: "No results found",
        });
      }
    }

    const workbookBuffer = await createPaymentEobResultWorkbookBuffer(comparisonRows);
    await fs.writeFile(path.join(outputRoot, "comparison_result.xlsx"), workbookBuffer);
    await context.emit(downloadableFileEvent("comparison_result.xlsx", workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    await emitRunZip(outputRoot, context);
    await uploadToSharePointIfEnabled(input.credentials, outputRoot, context);
    await context.log({ level: "info", message: `InstaMed Payment EOB processing completed. Output folder: ${outputRoot}`, eventName: "payment_eob_instamed_completed" });
  } finally {
    if (page && !page.isClosed()) {
      await page.locator("a,button").filter({ hasText: /^Logout$/i }).first().click({ timeout: 5000 }).catch(() => {});
    }
    await session?.browser?.close().catch(() => {});
  }
}

export function createInstamedRemittanceRunner(): AutomationRunner<PaymentEobRunInput> {
  return {
    workflowId: "payment-eob-download",
    portalId: instamedRemittanceConfig.id,
    name: instamedRemittanceConfig.name,
    validateInput(input) {
      if (!(input instanceof FormData)) {
        throw new Error("Payment EOB input must be multipart form data.");
      }
      return {
        credentialExcel: requireFile(input, "credentialExcel", "Credential Excel"),
        referenceExcel: requireFile(input, "referenceExcel", "Reference Excel"),
      };
    },
    async run(input, context) {
      const credentials = await readInstamedRemittanceCredentials(input.credentialExcel);
      const referenceRows = await readReferenceRows(input.referenceExcel);
      await context.log({
        level: "info",
        message: `InstaMed Payment EOB input validation completed for ${input.credentialExcel.name || "credential workbook"} and ${input.referenceExcel.name || "reference workbook"}. ${referenceRows.length} reference row(s) loaded.`,
        eventName: "payment_eob_instamed_validation_complete",
      });
      await runInstamedRemittanceJob({ credentials, referenceRows }, context);
    },
  };
}
