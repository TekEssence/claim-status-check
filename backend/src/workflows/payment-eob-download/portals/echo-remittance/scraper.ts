import crypto from "node:crypto";
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
import { echoRemittanceConfig } from "./config";
import { readEchoRemittanceCredentials, readReferenceRows } from "./input";

type RunInput = {
  credentials: PaymentEobCredentials;
  referenceRows: PaymentEobReferenceRow[];
};

type EchoPortalRecord = PaymentEobPortalRecord & {
  productionDate: string;
  rowIndex: number;
  documentPreference: "835" | "EPP";
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

function parsePortalDate(value: string): Date | null {
  const trimmed = value.trim();
  const mmDdYyyy = trimmed.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/) ?? trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mmDdYyyy) {
    return new Date(Date.UTC(Number(mmDdYyyy[3]), Number(mmDdYyyy[1]) - 1, Number(mmDdYyyy[2])));
  }
  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (yyyyMmDd) {
    return new Date(Date.UTC(Number(yyyyMmDd[1]), Number(yyyyMmDd[2]) - 1, Number(yyyyMmDd[3])));
  }
  return null;
}

function dateFilePart(value: string): string {
  const parsed = parsePortalDate(value);
  if (!parsed) return safeFilePart(value);
  return `${parsed.getUTCFullYear()}-${String(parsed.getUTCMonth() + 1).padStart(2, "0")}-${String(parsed.getUTCDate()).padStart(2, "0")}`;
}

function base32Decode(secret: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = "";
  for (const char of normalized) {
    const value = alphabet.indexOf(char);
    if (value === -1) throw new Error("Invalid Echo TOTP secret: expected base32 characters.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function generateTotp(secret: string): string {
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

async function fillTextbox(page: Page, locator: Locator, value: string): Promise<void> {
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.click({ timeout: 10000 });
  await locator.press("Control+A").catch(() => {});
  await locator.press("Backspace").catch(() => {});
  await locator.pressSequentially(value, { delay: 90 });
  await locator.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });
  await page.waitForTimeout(750);
}

async function clickButton(page: Page, name: RegExp): Promise<void> {
  const button = page.getByRole("button", { name }).first();
  await button.waitFor({ state: "visible", timeout: 30000 });
  await button.click({ timeout: 30000 });
}

async function submitEchoMfa(page: Page, mfaInput: Locator, code: string): Promise<void> {
  await mfaInput.waitFor({ state: "visible", timeout: 30000 });
  await mfaInput.click({ timeout: 10000 });
  await mfaInput.press("Control+A").catch(() => {});
  await mfaInput.press("Backspace").catch(() => {});
  await page.waitForTimeout(500);
  await mfaInput.pressSequentially(code, { delay: 180 });
  await page.waitForTimeout(1500);

  const verifyButton = page.getByRole("button", { name: /^Verify$/i }).first();
  const enabled = await verifyButton.evaluate((button) => {
    const element = button as HTMLButtonElement;
    return !element.disabled && !element.hasAttribute("disabled") && element.getAttribute("aria-disabled") !== "true";
  }).catch(() => false);

  if (enabled) {
    await verifyButton.click({ timeout: 30000 });
    return;
  }

  await mfaInput.press("Enter").catch(() => {});
  await page.waitForTimeout(1000);
  await mfaInput.locator("xpath=ancestor::form[1]").evaluate((form) => {
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }).catch(() => {});
}

async function login(page: Page, credentials: PaymentEobCredentials, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Echo Provider Payments login page.", eventName: "payment_eob_echo_login_open" });
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await fillTextbox(page, page.getByPlaceholder("Enter Username").first().or(page.locator("input[role='textbox']").first()), credentials.username);
  await clickButton(page, /^Continue$/i);

  await fillTextbox(page, page.getByPlaceholder("Enter Password").first().or(page.locator("input[type='password']").first()), credentials.password);
  await clickButton(page, /^Login$/i);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

  const mfaInput = page.getByPlaceholder(/\* \* \* \* \* \*/).first().or(page.locator(".authentication_input input, input[placeholder*='*']").first());
  if (await mfaInput.isVisible({ timeout: 60000 }).catch(() => false)) {
    await waitForFreshTotpWindow(page);
    await context.log({ level: "info", message: "Submitting Echo authenticator code.", eventName: "payment_eob_echo_mfa_code" });
    await submitEchoMfa(page, mfaInput, generateTotp(credentials.totpSecret));
  }

  await page.getByText("Inquiry", { exact: true }).first().waitFor({ state: "visible", timeout: 90000 });
  await context.log({ level: "info", message: "Echo login completed.", eventName: "payment_eob_echo_login_complete" });
}

async function selectKendoDropdownByLabel(page: Page, label: string, option: string): Promise<void> {
  const dropdown = page.locator(`xpath=//label[normalize-space()="${label}"]/following::*[@role="combobox"][1]`).first();
  await dropdown.click({ timeout: 30000 });
  const searchInput = page.locator(".k-animation-container:visible input, .k-list-container:visible input").first();
  if (await searchInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    await searchInput.fill(option);
  }
  await page.locator(".k-list-item, [role='option']").filter({ hasText: new RegExp(`^\\s*${option}\\s*$`, "i") }).first().click({ timeout: 15000 });
}

async function applyClearedAllTinFilter(page: Page, context: AutomationContext): Promise<void> {
  await selectKendoDropdownByLabel(page, "TIN", "All TIN").catch(async () => {
    await context.log({ level: "warn", message: "Unable to set Echo TIN to All TIN; continuing with the currently selected TIN.", eventName: "payment_eob_echo_tin_all_failed" });
  });
  await selectKendoDropdownByLabel(page, "Status", "Cleared");
  await clickButton(page, /^Search$/i);
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  await Promise.race([
    page.locator("tr.k-master-row").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined),
    page.getByText(/No records|No data/i).first().waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined),
  ]);
  await context.log({ level: "info", message: "Echo Inquiry filter applied: TIN=All TIN, Status=Cleared.", eventName: "payment_eob_echo_filter_applied" });
}

async function readVisiblePortalRows(page: Page): Promise<EchoPortalRecord[]> {
  const rows = page.locator("tr.k-master-row").filter({ has: page.locator("button.ANSI835, button.epp, button.eppViewed") });
  const count = await rows.count();
  const records: EchoPortalRecord[] = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = row.locator("td[role='gridcell'], td");
    if ((await cells.count()) < 8) continue;
    const tin = (await cells.nth(1).innerText().catch(() => "")).trim();
    const productionDate = (await cells.nth(2).innerText().catch(() => "")).trim();
    const checkNumber = normalizeCheckNumber(await cells.nth(3).innerText().catch(() => ""));
    if (!checkNumber || !parsePortalDate(productionDate)) continue;
    const has835 = await row.locator("button.ANSI835:visible").first().isVisible().catch(() => false);
    records.push({
      checkNumber,
      checkDate: productionDate,
      productionDate,
      rowIndex: index,
      documentPreference: has835 ? "835" : "EPP",
      payer: (await cells.nth(4).innerText().catch(() => "")).trim(),
      payee: tin,
      receivedByAvaility: "",
      amount: (await cells.nth(5).innerText().catch(() => "")).trim(),
      raw: { tin, productionDate },
    });
  }

  return records;
}

function filterLatestSevenDayWindow(records: EchoPortalRecord[]): EchoPortalRecord[] {
  const dated = records
    .map((record) => ({ record, date: parsePortalDate(record.productionDate) }))
    .filter((entry): entry is { record: EchoPortalRecord; date: Date } => Boolean(entry.date));
  const latest = dated.reduce<Date | null>((current, entry) => !current || entry.date > current ? entry.date : current, null);
  if (!latest) return [];
  const cutoff = new Date(latest);
  cutoff.setUTCDate(cutoff.getUTCDate() - 7);
  return dated.filter((entry) => entry.date >= cutoff && entry.date <= latest).map((entry) => entry.record);
}

async function saveBlobFromPopup(popup: Page, outputPath: string): Promise<void> {
  await popup.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  await popup.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  const payload = await popup.evaluate(async () => {
    const response = await fetch(window.location.href);
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  });
  await fs.writeFile(outputPath, Buffer.from(payload, "base64"));
}

async function downloadEchoDocument(page: Page, record: EchoPortalRecord, outputFolder: string): Promise<string> {
  const rows = page.locator("tr.k-master-row").filter({ has: page.locator("button.ANSI835, button.epp, button.eppViewed") });
  const row = rows.nth(record.rowIndex);
  await row.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  const button = record.documentPreference === "835"
    ? row.locator("button.ANSI835:visible").first()
    : row.locator("button.epp:visible, button.eppViewed:visible").first();

  const downloadPromise = page.waitForEvent("download", { timeout: 90000 }).catch(() => null);
  const popupPromise = page.waitForEvent("popup", { timeout: 90000 }).catch(() => null);
  await button.click({ timeout: 30000 });
  const result = await Promise.race([downloadPromise, popupPromise]);
  const defaultExtension = record.documentPreference === "835" ? ".835" : ".pdf";
  const filename = `${safeFilePart(record.checkNumber)}_${dateFilePart(record.productionDate)}_${record.documentPreference}${defaultExtension}`;
  const outputPath = path.join(outputFolder, filename);

  if (result && "saveAs" in result) {
    const suggestedExtension = path.extname(result.suggestedFilename());
    const finalFilename = suggestedExtension && suggestedExtension !== defaultExtension
      ? `${safeFilePart(record.checkNumber)}_${dateFilePart(record.productionDate)}_${record.documentPreference}${suggestedExtension}`
      : filename;
    await result.saveAs(path.join(outputFolder, finalFilename));
    return finalFilename;
  }

  if (result) {
    try {
      await saveBlobFromPopup(result, outputPath);
    } finally {
      if (!result.isClosed()) await result.close().catch(() => {});
    }
    return filename;
  }

  throw new Error(`Echo ${record.documentPreference} document did not download or open.`);
}

async function emitRunZip(outputRoot: string, context: AutomationContext): Promise<void> {
  const datePart = todayYyyyMmDd();
  const runFolder = "run-01";
  const zipRootName = `PaymentEobDownloads/${datePart}/${runFolder}`;
  const zipBuffer = await createStoredZipFromFolder(outputRoot, zipRootName);
  const zipFilename = `EchoPaymentEobDownloads_${datePart}_${runFolder}.zip`;
  await context.emit(downloadableFileEvent(zipFilename, zipBuffer, "application/zip"));
}

async function uploadToSharePointIfEnabled(credentials: PaymentEobCredentials, outputRoot: string, context: AutomationContext): Promise<void> {
  if (process.env.PAYMENT_EOB_SHAREPOINT_UPLOAD_ENABLED !== "true") return;
  await uploadPaymentEobOutputToSharePoint(credentials, outputRoot, context);
}

export async function runEchoRemittanceJob(input: RunInput, context: AutomationContext): Promise<void> {
  const outputRoot = path.join(getJobDataPath(context.jobId, "outputs"), `echo-remittance-${context.jobId}`);
  const outputDocumentFolder = path.join(outputRoot, "Documents");
  await fs.mkdir(outputDocumentFolder, { recursive: true });

  const referenceNumbers = new Set(input.referenceRows.map((row) => row.checkNumber));
  const comparisonRows: PaymentEobComparisonRow[] = [];
  let session: Awaited<ReturnType<typeof launchAutomationBrowser>> | null = null;
  let page: Page | null = null;

  await context.emit({ type: "progress", completed: 0, total: 1 });
  try {
    session = await launchAutomationBrowser();
    page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(Number(process.env.PORTAL_ECHO_REMITTANCE_TIMEOUT_MS || 30000));
    page.setDefaultNavigationTimeout(Number(process.env.PORTAL_ECHO_REMITTANCE_NAVIGATION_TIMEOUT_MS || 60000));

    await login(page, input.credentials, context);
    await applyClearedAllTinFilter(page, context);

    const portalRecords = filterLatestSevenDayWindow(await readVisiblePortalRows(page));
    await context.log({
      level: "info",
      message: `Echo returned ${portalRecords.length} cleared row(s) in the latest 7-day production-date window.`,
      eventName: "payment_eob_echo_window_records",
    });

    const uniqueRecords = portalRecords.filter((record) => {
      if (referenceNumbers.has(record.checkNumber)) {
        comparisonRows.push({
          checkNumber: record.checkNumber,
          checkDate: record.productionDate,
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
        await context.emit({ type: "cancelled", message: "Echo Payment EOB download cancelled." });
        break;
      }
      try {
        await context.log({
          level: "info",
          message: `Downloading Echo ${record.documentPreference} document for ECHO Draft Number ${record.checkNumber}.`,
          eventName: "payment_eob_echo_document_download",
        });
        const filename = await downloadEchoDocument(page, record, outputDocumentFolder);
        comparisonRows.push({
          checkNumber: record.checkNumber,
          checkDate: record.productionDate,
          comparison: "Unique",
          searchResult: "Found",
          pdfStatus: "Downloaded",
          filename,
          message: `Downloaded ${record.documentPreference} document from Echo.`,
        });
      } catch (error) {
        comparisonRows.push({
          checkNumber: record.checkNumber,
          checkDate: record.productionDate,
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
          message: "No Echo portal records were available for comparison.",
        });
      }
    }

    const workbookBuffer = await createPaymentEobResultWorkbookBuffer(comparisonRows);
    await fs.writeFile(path.join(outputRoot, "comparison_result.xlsx"), workbookBuffer);
    await context.emit(downloadableFileEvent("comparison_result.xlsx", workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    await emitRunZip(outputRoot, context);
    await uploadToSharePointIfEnabled(input.credentials, outputRoot, context);
    await context.log({ level: "info", message: `Echo Payment EOB processing completed. Output folder: ${outputRoot}`, eventName: "payment_eob_echo_completed" });
  } finally {
    if (page && !page.isClosed()) {
      await page.locator("button[title='Logout'], a,button").filter({ hasText: /log ?out|sign ?out/i }).first().click({ timeout: 5000 }).catch(() => {});
    }
    await session?.browser?.close().catch(() => {});
  }
}

export function createEchoRemittanceRunner(): AutomationRunner<PaymentEobRunInput> {
  return {
    workflowId: "payment-eob-download",
    portalId: echoRemittanceConfig.id,
    name: echoRemittanceConfig.name,
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
      const credentials = await readEchoRemittanceCredentials(input.credentialExcel);
      const referenceRows = await readReferenceRows(input.referenceExcel!);
      await context.log({
        level: "info",
        message: `Echo Payment EOB input validation completed for ${input.credentialExcel.name || "credential workbook"} and ${input.referenceExcel!.name || "reference workbook"}. ${referenceRows.length} reference row(s) loaded.`,
        eventName: "payment_eob_echo_validation_complete",
      });
      await runEchoRemittanceJob({ credentials, referenceRows }, context);
    },
  };
}
