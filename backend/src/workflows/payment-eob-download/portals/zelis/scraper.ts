import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import type { AutomationContext, AutomationRunner } from "../../../types";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { getJobDataPath } from "@/backend/src/core/storage";
import type { PaymentEobComparisonRow, PaymentEobCredentials, PaymentEobRunInput } from "../../types";
import { createPaymentEobResultWorkbookBuffer } from "../availity-remittance/output-builder";
import { uploadPaymentEobOutputToSharePoint } from "../availity-remittance/sharepoint";
import { createStoredZipFromFolder } from "../availity-remittance/zip";
import { zelisConfig } from "./config";
import { readZelisCredentials } from "./input";

type RunInput = {
  credentials: PaymentEobCredentials;
};

type ZelisPaymentRow = {
  row: Locator;
  paymentDate: string;
  paymentId: string;
  hasCapturedCheckmark: boolean;
};

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
  return value.trim().replace(/[<>:"/\\|?*]/g, "_");
}

function dateFilePart(value: string): string {
  const mmDdYyyy = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (mmDdYyyy) {
    return `${mmDdYyyy[3]}-${mmDdYyyy[1].padStart(2, "0")}-${mmDdYyyy[2].padStart(2, "0")}`;
  }
  return safeFilePart(value);
}

function base32Decode(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = "";
  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value === -1) throw new Error("Invalid Zelis TOTP secret: expected base32 characters.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret: string): string {
  if (!secret.trim()) throw new Error("Zelis TOTP secret is empty. Check the Secret Key column in the credential Excel.");
  const counter = Math.floor(Date.now() / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % 1000000).padStart(6, "0");
}

async function waitForFreshTotpWindow(page: Page): Promise<void> {
  const secondsRemaining = 30 - (Math.floor(Date.now() / 1000) % 30);
  if (secondsRemaining < 8) {
    await page.waitForTimeout((secondsRemaining + 1) * 1000);
  }
}

async function clickExactText(page: Page, text: RegExp, timeout = 30000): Promise<void> {
  await page.locator("a,button,label").filter({ hasText: text }).first().click({ timeout });
}

async function clickSubmit(page: Page): Promise<void> {
  const submit = page.locator("button[type='submit'], input[type='submit'], #submitbtn").first();
  await submit.click({ timeout: 30000 });
}

async function fillAngularInput(locator: Locator, value: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.click({ timeout: 10000 });
  await locator.press("Control+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.pressSequentially(value, { delay: 20 });
  await locator.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });
}

async function clickLoginSubmit(page: Page): Promise<void> {
  const loginButton = page
    .locator("form button, form input[type='submit'], button.btn-primary, input.btn-primary")
    .filter({ hasText: /^Login$/i })
    .first();

  if (await loginButton.isVisible({ timeout: 10000 }).catch(() => false)) {
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll("form button, form input[type='submit'], button.btn-primary, input.btn-primary")]
        .find((candidate) => candidate.textContent?.trim().toLowerCase() === "login" || (candidate as HTMLInputElement).value?.trim().toLowerCase() === "login");
      return Boolean(button && !(button as HTMLButtonElement | HTMLInputElement).disabled && !button.hasAttribute("disabled"));
    }, null, { timeout: 10000 }).catch(() => {});

    const disabled = await loginButton.evaluate((button) => {
      const element = button as HTMLButtonElement | HTMLInputElement;
      return element.disabled || element.hasAttribute("disabled");
    }).catch(() => true);
    if (!disabled) {
      await loginButton.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
      await loginButton.click({ timeout: 15000 });
      return;
    }

    await loginButton.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await loginButton.click({ timeout: 5000, force: true }).catch(() => {});
    await page.locator("form").first().evaluate((form) => {
      if (form instanceof HTMLFormElement) form.requestSubmit();
    });
    return;
  }

  const password = page.locator("#password, input[name='password']").first();
  if (await password.isVisible({ timeout: 3000 }).catch(() => false)) {
    await password.press("Enter");
    return;
  }

  await page.locator("form").first().evaluate((form) => {
    if (form instanceof HTMLFormElement) form.requestSubmit();
  });
}

async function login(page: Page, credentials: PaymentEobCredentials, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Zelis login page.", eventName: "payment_eob_zelis_login_open" });
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await fillAngularInput(page.locator("#username, input[name='username']").first(), credentials.username);
  await fillAngularInput(page.locator("#password, input[name='password']").first(), credentials.password);
  await clickLoginSubmit(page);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  const methodSelect = page.locator("#SelectedProvider, select[name='SelectedProvider']").first();
  if (await methodSelect.isVisible({ timeout: 60000 }).catch(() => false)) {
    await context.log({ level: "info", message: "Selecting Zelis Authenticator App MFA method.", eventName: "payment_eob_zelis_mfa_method" });
    await methodSelect.selectOption({ label: "Authenticator App" }).catch(async () => {
      await methodSelect.selectOption("Authenticator App");
    });
    await clickSubmit(page);
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  }

  const codeInput = page.locator("#code, input[name='code']").first();
  if (await codeInput.isVisible({ timeout: 60000 }).catch(() => false)) {
    await waitForFreshTotpWindow(page);
    const code = generateTotp(credentials.totpSecret);
    await context.log({ level: "info", message: "Submitting Zelis authenticator code.", eventName: "payment_eob_zelis_mfa_code" });
    await codeInput.fill(code);
    await page.locator("#rememberMe").check({ force: true, timeout: 3000 }).catch(() => {});
    await clickSubmit(page);
    await page.waitForLoadState("networkidle", { timeout: 60000 }).catch(() => {});
  }

  await context.log({ level: "info", message: "Zelis login completed.", eventName: "payment_eob_zelis_login_complete" });
}

async function openPaymentPage(page: Page, context: AutomationContext): Promise<void> {
  const paymentUrl = "https://provider.zelispayments.com/Payment";
  await page.goto(paymentUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await page.locator("#PaymentView, #paymentsGrid, .payment-holder").first().waitFor({ state: "visible", timeout: 90000 });
  await waitForPaymentGrid(page);
  await context.log({ level: "info", message: "Zelis Payment page opened.", eventName: "payment_eob_zelis_payment_opened" });
}

async function waitForPaymentGrid(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await Promise.race([
    page.locator("table tbody tr").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined),
    page.getByText(/There are no records to display|try adjusting your search/i).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined),
  ]);
}

async function selectNotDownloaded(page: Page, context: AutomationContext): Promise<void> {
  const radio = page.locator('input[name="options"][value="NotDownloaded"], #option3').first();
  if (await radio.count()) {
    await radio.check({ force: true, timeout: 15000 }).catch(async () => {
      await radio.locator("xpath=ancestor::label[1]").click({ timeout: 15000 });
    });
  } else {
    await clickExactText(page, /^Not Downloaded$/i);
  }
  await waitForPaymentGrid(page);
  await context.log({ level: "info", message: "Zelis Not Downloaded filter selected.", eventName: "payment_eob_zelis_not_downloaded" });
}

async function hasNoRecords(page: Page): Promise<boolean> {
  return await page.getByText(/There are no records to display|try adjusting your search/i).first().isVisible().catch(() => false);
}

async function readPaymentRows(page: Page): Promise<ZelisPaymentRow[]> {
  const rows = page.locator("table tbody tr").filter({ has: page.locator("a.paymentDetail[data-paymentid]") });
  const count = await rows.count();
  const result: ZelisPaymentRow[] = [];
  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const paymentLink = row.locator("a.paymentDetail[data-paymentid]").first();
    const paymentId = (await paymentLink.getAttribute("data-paymentid").catch(() => "")) || (await paymentLink.innerText().catch(() => "")).trim();
    if (!paymentId) continue;
    const cells = row.locator("td[role='gridcell'], td");
    const paymentDate = (await cells.nth(1).innerText().catch(() => "")).trim();
    const downloadLink = row.locator("a.downloadPaymentLink").filter({ hasText: /^Download$/i }).first();
    const downloadClass = (await downloadLink.getAttribute("class").catch(() => "")) ?? "";
    const hasCapturedCheckmark = /\bdownloadSelected\b/.test(downloadClass);
    result.push({ row, paymentDate, paymentId, hasCapturedCheckmark });
  }
  return result;
}

async function saveZelisDownload(page: Page, payment: ZelisPaymentRow, outputFolder: string): Promise<string> {
  const downloadLink = payment.row.locator("a.downloadPaymentLink").filter({ hasText: /^Download$/i }).first();
  const downloadPromise = page.waitForEvent("download", { timeout: 90000 });
  await downloadLink.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  await downloadLink.click({ timeout: 30000 });
  const download = await downloadPromise;
  const extension = path.extname(download.suggestedFilename()) || ".pdf";
  const filename = `${safeFilePart(payment.paymentId)}_${dateFilePart(payment.paymentDate)}${extension}`;
  await download.saveAs(path.join(outputFolder, filename));
  return filename;
}

async function capturePaymentPopupScreenshot(page: Page, payment: ZelisPaymentRow, screenshotFolder: string): Promise<string> {
  const paymentLink = page
    .locator(`a.paymentDetail[data-paymentid="${payment.paymentId}"]`)
    .or(payment.row.locator("a.paymentDetail[data-paymentid]"))
    .first();
  await paymentLink.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  await paymentLink.click({ timeout: 30000 });

  const modal = page.locator("#modalPopupDiv:visible").first();
  await modal.waitFor({ state: "visible", timeout: 30000 });
  await page.waitForTimeout(500);

  const filename = `${safeFilePart(payment.paymentId)}_CC.png`;
  const modalWindow = modal.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' k-window ')][1]");
  const screenshotTarget = await modalWindow.isVisible({ timeout: 3000 }).catch(() => false) ? modalWindow : modal;
  await screenshotTarget.screenshot({ path: path.join(screenshotFolder, filename) });

  await page.locator(".k-window-action[aria-label='Close'], .k-window-titlebar .k-i-close, button[aria-label='Close']").first().click({ timeout: 5000 }).catch(async () => {
    await page.keyboard.press("Escape").catch(() => {});
  });
  await modal.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  return filename;
}

async function goToNextPage(page: Page): Promise<boolean> {
  const next = page.locator(".k-pager-wrap a.k-pager-nav[title='Go to the next page']:not(.k-state-disabled), .k-pager-wrap a[data-page]:has(.k-i-arrow-e)").first();
  if (!(await next.isVisible().catch(() => false))) return false;
  const className = await next.getAttribute("class").catch(() => "");
  if (className?.includes("k-state-disabled")) return false;
  await next.click({ timeout: 15000 });
  await waitForPaymentGrid(page);
  return true;
}

async function emitRunZip(outputRoot: string, context: AutomationContext): Promise<void> {
  const datePart = todayYyyyMmDd();
  const runFolder = "run-01";
  const zipRootName = `PaymentEobDownloads/${datePart}/${runFolder}`;
  const zipBuffer = await createStoredZipFromFolder(outputRoot, zipRootName);
  const zipFilename = `ZelisPaymentEobDownloads_${datePart}_${runFolder}.zip`;
  await fs.writeFile(path.join(outputRoot, zipFilename), zipBuffer);
  await context.emit(downloadableFileEvent(zipFilename, zipBuffer, "application/zip"));
}

function getLocalDownloadsRoot(jobId: string): string {
  return path.join(os.homedir(), "Downloads", `ZelisPaymentEobDownloads_${todayYyyyMmDd()}_${safeFilePart(jobId)}`);
}

async function copyFolderContents(sourceRoot: string, targetRoot: string): Promise<void> {
  await fs.mkdir(targetRoot, { recursive: true });
  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await copyFolderContents(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function uploadToSharePointIfEnabled(credentials: PaymentEobCredentials, outputRoot: string, context: AutomationContext): Promise<void> {
  if (process.env.PAYMENT_EOB_SHAREPOINT_UPLOAD_ENABLED !== "true") return;
  await uploadPaymentEobOutputToSharePoint(credentials, outputRoot, context);
}

export async function runZelisJob(input: RunInput, context: AutomationContext): Promise<void> {
  const outputRoot = path.join(getJobDataPath(context.jobId, "outputs"), `zelis-${context.jobId}`);
  const outputPdfFolder = path.join(outputRoot, "PDFs");
  const screenshotFolder = path.join(outputRoot, "Screenshots");
  await fs.mkdir(outputPdfFolder, { recursive: true });
  await fs.mkdir(screenshotFolder, { recursive: true });

  const comparisonRows: PaymentEobComparisonRow[] = [];
  let session: Awaited<ReturnType<typeof launchAutomationBrowser>> | null = null;
  let page: Page | null = null;

  await context.emit({ type: "progress", completed: 0, total: 1 });
  try {
    session = await launchAutomationBrowser();
    page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(Number(process.env.PORTAL_ZELIS_TIMEOUT_MS || 30000));
    page.setDefaultNavigationTimeout(Number(process.env.PORTAL_ZELIS_NAVIGATION_TIMEOUT_MS || 60000));

    await login(page, input.credentials, context);
    await openPaymentPage(page, context);
    await context.log({
      level: "info",
      message: "Processing Zelis payments from the default All filter. Rows with a green checkmark will be skipped.",
      eventName: "payment_eob_zelis_all_filter_processing",
    });

    let generatedFileCount = 0;
    let pendingPaymentCount = 0;

    if (await hasNoRecords(page)) {
      await context.log({ level: "info", message: "Zelis returned no payment records in the All filter.", eventName: "payment_eob_zelis_no_results" });
    } else {
      let completed = 0;
      let pageIndex = 1;
      do {
        const rows = await readPaymentRows(page);
        await context.emit({ type: "progress", completed, total: Math.max(completed + rows.length, 1) });
        for (const payment of rows) {
          if (context.isCancelled?.()) {
            await context.emit({ type: "cancelled", message: "Zelis Payment EOB download cancelled." });
            break;
          }
          if (payment.hasCapturedCheckmark) {
            comparisonRows.push({
              checkNumber: payment.paymentId,
              checkDate: payment.paymentDate,
              comparison: "Existing",
              searchResult: "Skipped",
              pdfStatus: "Skipped",
              filename: "",
              message: "Green checkmark present; skipped.",
            });
            completed += 1;
            await context.emit({ type: "progress", completed, total: Math.max(completed, 1) });
            continue;
          }

          try {
            await context.log({ level: "info", message: `Processing Zelis Payment ID ${payment.paymentId}.`, eventName: "payment_eob_zelis_payment_process" });
            const downloadFilename = await saveZelisDownload(page, payment, outputPdfFolder);
            const screenshotFilename = await capturePaymentPopupScreenshot(page, payment, screenshotFolder);
            pendingPaymentCount += 1;
            generatedFileCount += 2;
            comparisonRows.push({
              checkNumber: payment.paymentId,
              checkDate: payment.paymentDate,
              comparison: "Unique",
              searchResult: "Found",
              pdfStatus: "Downloaded",
              filename: `${downloadFilename}; ${screenshotFilename}`,
              message: "Downloaded payment file and captured Payment ID popup screenshot.",
            });
          } catch (error) {
            comparisonRows.push({
              checkNumber: payment.paymentId,
              checkDate: payment.paymentDate,
              comparison: "Unique",
              searchResult: "Error",
              pdfStatus: "Error",
              filename: "",
              message: error instanceof Error ? error.message : String(error),
            });
          }
          completed += 1;
          await context.emit({ type: "progress", completed, total: Math.max(completed, 1) });
        }
        pageIndex += 1;
      } while (!context.isCancelled?.() && pageIndex <= 20 && await goToNextPage(page));
    }

    if (comparisonRows.length > 0 && pendingPaymentCount === 0 && comparisonRows.every((row) => row.pdfStatus === "Skipped")) {
      await context.log({
        level: "info",
        message: "No pending payments found. All visible rows already have green tick.",
        eventName: "payment_eob_zelis_no_pending_green_tick",
      });
    }

    if (comparisonRows.some((row) => row.pdfStatus !== "Skipped")) {
      const workbookBuffer = await createPaymentEobResultWorkbookBuffer(comparisonRows);
      const summaryFilename = "zelis_processing_summary.xlsx";
      await fs.writeFile(path.join(outputRoot, summaryFilename), workbookBuffer);
      await context.emit(downloadableFileEvent(summaryFilename, workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    }

    if (generatedFileCount > 0) {
      await emitRunZip(outputRoot, context);
      const downloadsRoot = getLocalDownloadsRoot(context.jobId);
      await copyFolderContents(outputRoot, downloadsRoot);
      await context.log({
        level: "info",
        message: `Copied Zelis output files to Downloads folder: ${downloadsRoot}`,
        eventName: "payment_eob_zelis_downloads_copy_complete",
      });
    } else {
      await context.log({
        level: "info",
        message: "No Zelis PDFs or screenshots were generated, so no ZIP file was created.",
        eventName: "payment_eob_zelis_zip_skipped",
      });
    }
    await uploadToSharePointIfEnabled(input.credentials, outputRoot, context);
    await context.log({ level: "info", message: `Zelis Payment EOB processing completed. Output folder: ${outputRoot}`, eventName: "payment_eob_zelis_completed" });
  } finally {
    if (page && !page.isClosed()) {
      await page.locator("a,button").filter({ hasText: /log ?out|sign ?out/i }).first().click({ timeout: 5000 }).catch(() => {});
    }
    await session?.browser?.close().catch(() => {});
  }
}

export function createZelisRunner(): AutomationRunner<PaymentEobRunInput> {
  return {
    workflowId: "payment-eob-download",
    portalId: zelisConfig.id,
    name: zelisConfig.name,
    validateInput(input) {
      if (!(input instanceof FormData)) {
        throw new Error("Payment EOB input must be multipart form data.");
      }
      return {
        credentialExcel: requireFile(input, "credentialExcel", "Credential Excel"),
      };
    },
    async run(input, context) {
      const credentials = await readZelisCredentials(input.credentialExcel);
      await context.log({
        level: "info",
        message: `Zelis Payment EOB input validation completed for ${input.credentialExcel.name || "credential workbook"}.`,
        eventName: "payment_eob_zelis_validation_complete",
      });
      await runZelisJob({ credentials }, context);
    },
  };
}
