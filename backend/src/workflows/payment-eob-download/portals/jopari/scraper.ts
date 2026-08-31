import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import type { Locator, Page } from "playwright-core";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { getJobDataPath } from "@/backend/src/core/storage";
import { waitForScrapeJobInput } from "@/backend/src/jobs/job-store";
import type { AutomationContext, AutomationRunner } from "../../../types";
import type { PaymentEobCredentials, PaymentEobRunInput } from "../../types";
import { createStoredZipFromFolder } from "../availity-remittance/zip";
import { jopariConfig } from "./config";
import { normalizeJopariIdentifier, readJopariControlLog, readJopariCredentials, type JopariControlReference } from "./input";
import { createJopariAuditWorkbook, type JopariPaymentRow } from "./output";

type RunInput = { credentials: PaymentEobCredentials; control: JopariControlReference };
type ExportRow = Omit<JopariPaymentRow, "comparison" | "searchResult" | "downloadStatus" | "filename" | "message">;

function requiredFile(formData: FormData, key: string, label: string): File {
  const file = formData.get(key);
  if (!(file instanceof File) || !file.size) throw new Error(`${label} is required.`);
  return file;
}

function safe(value: string): string { return value.replace(/[<>:"/\\|?*]/g, "_"); }
function dateStamp(): string { return new Date().toISOString().slice(0, 10); }
function event(filename: string, buffer: Buffer, mimeType: string) {
  return { type: "file_download", filename, base64: buffer.toString("base64"), mimeType };
}
function asText(value: unknown): string {
  if (value == null) return "";
  if (value instanceof Date) return `${String(value.getUTCMonth() + 1).padStart(2, "0")}/${String(value.getUTCDate()).padStart(2, "0")}/${value.getUTCFullYear()}`;
  if (typeof value === "object" && "text" in value) return String((value as { text?: unknown }).text ?? "").trim();
  if (typeof value === "object" && "result" in value) return asText((value as { result?: unknown }).result);
  return String(value).trim();
}
function alias(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, ""); }

export async function parseJopariExport(buffer: Buffer): Promise<ExportRow[]> {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
  let headerRow = 0;
  const headers: string[] = [];
  grid.forEach((row, index) => {
    if (headerRow) return;
    const values = row.map(asText);
    if (values.some((value) => alias(value) === "eftcheck" || alias(value) === "paymentmethod")) {
      headerRow = index + 1;
      values.forEach((value, column) => { headers[column] = value; });
    }
  });
  if (!headerRow) throw new Error("Jopari export did not contain the EFT/Check and Payment Method columns.");
  const result: ExportRow[] = [];
  const pick = (data: Record<string, string>, names: string[]) => names.map(alias).map((name) => data[name]).find(Boolean) ?? "";
  grid.forEach((row, index) => {
    if (index + 1 <= headerRow) return;
    const data: Record<string, string> = {};
    headers.forEach((header, column) => { if (header) data[alias(header)] = asText(row[column]); });
    const paymentMethod = pick(data, ["Payment Method", "Pay Method"]);
    if (!/^(?:ACH|NON)$/i.test(paymentMethod.trim())) return;
    result.push({
      eftCheckNumber: pick(data, ["EFT Check", "EFT/Check #", "Check EFT"]),
      batchId: pick(data, ["Batch ID"]), payDate: pick(data, ["Pay Date"]),
      claimsPaid: pick(data, ["Claims Paid"]), paymentMethod,
      billingTin: pick(data, ["Billing TIN"]), paidAmount: pick(data, ["Paid Amount"]), payer: pick(data, ["Payer"]),
    });
  });
  return result;
}

export function existsInControlLog(row: ExportRow, control: JopariControlReference): boolean {
  const check = normalizeJopariIdentifier(row.eftCheckNumber);
  if (check && check !== "0" && control.checkNumbers.has(check)) return true;
  const batch = normalizeJopariIdentifier(row.batchId);
  return Boolean(batch && control.fileNames.some((fileName) => fileName.includes(batch)));
}

async function login(page: Page, credentials: PaymentEobCredentials, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Jopari Remittance Gateway.", eventName: "jopari_login_open" });
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  const loginId = page.locator("#login-id");
  const password = page.locator("#password");
  await loginId.waitFor({ state: "visible", timeout: 30000 });
  await password.waitFor({ state: "visible", timeout: 30000 });
  await loginId.fill(credentials.username);
  await password.fill(credentials.password);

  const populated = await page.evaluate(({ username, passwordValue }) => {
    const visibleUsername = document.querySelector<HTMLInputElement>("#login-id");
    const visiblePassword = document.querySelector<HTMLInputElement>("#password");
    const hiddenUsername = document.querySelector<HTMLInputElement>("#h_username");
    const hiddenPassword = document.querySelector<HTMLInputElement>("#h_password");
    if (visibleUsername) visibleUsername.value = username;
    if (visiblePassword) visiblePassword.value = passwordValue;
    if (hiddenUsername) hiddenUsername.value = username;
    if (hiddenPassword) hiddenPassword.value = passwordValue;
    for (const input of [visibleUsername, visiblePassword, hiddenUsername, hiddenPassword]) {
      input?.dispatchEvent(new Event("input", { bubbles: true }));
      input?.dispatchEvent(new Event("change", { bubbles: true }));
    }
    visibleUsername?.dispatchEvent(new Event("blur", { bubbles: true }));
    visiblePassword?.dispatchEvent(new Event("blur", { bubbles: true }));
    return {
      visibleUsername: Boolean(visibleUsername?.value),
      visiblePassword: Boolean(visiblePassword?.value),
      hiddenUsername: Boolean(hiddenUsername?.value),
      hiddenPassword: Boolean(hiddenPassword?.value),
    };
  }, { username: credentials.username, passwordValue: credentials.password });

  const finalUsernameCharacter = Array.from(credentials.username).at(-1) ?? "?";
  await context.log({
    level: "info",
    message: `Jopari credentials prepared: Login ID ending in ***${finalUsernameCharacter}; password populated: ${populated.visiblePassword ? "Yes" : "No"}; hidden fields synchronized: ${populated.hiddenUsername && populated.hiddenPassword ? "Yes" : "No"}.`,
    eventName: "jopari_login_fields_prepared",
  });
  if (!populated.visibleUsername || !populated.visiblePassword || !populated.hiddenUsername || !populated.hiddenPassword) {
    throw new Error("Jopari login fields could not be populated and synchronized safely.");
  }

  await page.locator('input[type="submit"][value="login"], input[type="submit"][value="LOGIN"]').click();
  await page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  const loginOutcomeHandle = await page.waitForFunction(() => {
    if (document.querySelector("#dashboard-tab-link, #era-tab-link")) return "dashboard";
    if (document.querySelector("#mfa-section")) return "mfa";
    const errorText = document.querySelector(".errorMessage")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const requiredFields = /Login ID is required|Password is required/i.test(`${errorText} ${document.body.innerText}`);
    if (requiredFields) return "error:Jopari reported that the submitted Login ID or Password was empty.";
    if (errorText || /Validation Error/i.test(document.body.innerText)) return "error:Jopari rejected the login submission. Verify the credential workbook and portal access.";
    return "";
  }, undefined, { timeout: 30000 });
  const loginOutcome = await loginOutcomeHandle.jsonValue() as string;
  await loginOutcomeHandle.dispose();
  if (loginOutcome.startsWith("error:")) {
    throw new Error(loginOutcome.slice("error:".length));
  }

  const mfa = page.locator("#mfa-section");
  if (loginOutcome === "mfa") {
    const emailLink = mfa.locator("a").filter({ hasText: /Use E-?mail MFA instead/i }).first();
    await emailLink.waitFor({ state: "visible", timeout: 30000 });
    await context.log({ level: "info", message: "Jopari MFA page opened; switching to email verification.", eventName: "jopari_email_mfa_switch" });

    let emailModeReady = false;
    for (let attempt = 1; attempt <= 3 && !emailModeReady; attempt += 1) {
      await emailLink.scrollIntoViewIfNeeded().catch(() => {});
      if (attempt < 3) {
        await emailLink.click({ timeout: 10000 }).catch(() => {});
      } else {
        await emailLink.evaluate((link: HTMLElement) => link.click()).catch(() => {});
      }
      emailModeReady = await page.locator("#step1-description")
        .filter({ hasText: /one-time authentication code has been sent|code has been sent to the email/i })
        .waitFor({ state: "visible", timeout: 10000 })
        .then(() => true)
        .catch(() => false);
      if (!emailModeReady) {
        await context.log({ level: "warn", message: `Jopari did not switch to email MFA on attempt ${attempt}/3; retrying.`, eventName: "jopari_email_mfa_retry" });
      }
    }
    if (!emailModeReady) {
      throw new Error("Jopari did not switch from authenticator MFA to email MFA after three attempts.");
    }
    await context.log({ level: "info", message: "Jopari confirmed that the verification code was sent by email.", eventName: "jopari_email_mfa_ready" });
    const timeoutMs = Number(process.env.PORTAL_JOPARI_OTP_TIMEOUT_MS || 600000);
    await context.emit({ type: "input_request", inputName: "jopari_otp", label: "Jopari email verification code", message: "Enter the 6-digit code sent by Jopari email.", timeoutMs });
    const otp = await waitForScrapeJobInput(context.jobId, "jopari_otp", timeoutMs);
    await page.locator("#mfa-onc-input").fill(otp);
    await mfa.getByRole("button", { name: "Submit", exact: true }).click();
  }
  await page.locator("#dashboard-tab-link, #era-tab-link").first().waitFor({ state: "visible", timeout: 60000 });
  await context.log({ level: "info", message: "Jopari login completed.", eventName: "jopari_login_complete" });
}

async function saveDownload(page: Page, click: () => Promise<void>, folder: string, fallback: string): Promise<string> {
  const downloadPromise = page.waitForEvent("download", { timeout: 90000 });
  await click();
  const download = await downloadPromise;
  const filename = safe(download.suggestedFilename() || fallback);
  await download.saveAs(path.join(folder, filename));
  return filename;
}

async function openMailbox(page: Page): Promise<Locator> {
  await page.locator("#mailbox-tab-link").click();
  const table = page.locator("#mailbox-list");
  await table.waitFor({ state: "visible", timeout: 30000 });
  await page.locator("#mailbox-list_processing").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  return table;
}

async function mailboxEraFilenames(table: Locator): Promise<Set<string>> {
  const rows = table.locator("tbody tr").filter({ hasText: /ERA Report Multiple File ZIP Download/i });
  const filenames = new Set<string>();
  for (let index = 0; index < await rows.count(); index += 1) {
    const filename = await rows.nth(index).locator(".data-mailbox-filename").getAttribute("title").catch(() => null)
      ?? await rows.nth(index).locator(".data-mailbox-filename").textContent().catch(() => null);
    if (filename?.trim()) filenames.add(filename.trim());
  }
  return filenames;
}

async function refreshMailbox(page: Page): Promise<void> {
  const refresh = page.locator("a,button").filter({ hasText: /^\s*Refresh\s*$/i }).first()
    .or(page.locator(".mailbox-refresh, .fa-refresh").first());
  if (await refresh.isVisible({ timeout: 2000 }).catch(() => false)) await refresh.click();
  else await page.locator("#mailbox-tab-link").click();
  await page.locator("#mailbox-list_processing").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
}

async function waitForNewMailboxEra(page: Page, previousFilenames: Set<string>, context: AutomationContext): Promise<Locator> {
  const timeoutMs = Number(process.env.PORTAL_JOPARI_MAILBOX_TIMEOUT_MS || 300000);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = page.locator("#mailbox-list tbody tr").filter({ hasText: /ERA Report Multiple File ZIP Download/i });
    for (let index = 0; index < await rows.count(); index += 1) {
      const row = rows.nth(index);
      const filename = (await row.locator(".data-mailbox-filename").getAttribute("title").catch(() => null)
        ?? await row.locator(".data-mailbox-filename").textContent().catch(() => null))?.trim() ?? "";
      const downloadable = await row.locator(".fa-download").isVisible().catch(() => false);
      if (filename && !previousFilenames.has(filename) && downloadable) return row;
    }
    await context.log({ level: "info", message: "Jopari ERA report is still being prepared in Mailbox; refreshing.", eventName: "jopari_mailbox_wait" });
    await page.waitForTimeout(5000);
    await refreshMailbox(page);
  }
  throw new Error("Timed out waiting for the newly requested Jopari ERA ZIP in Mailbox.");
}

async function phaseOne(page: Page, outputRoot: string, context: AutomationContext): Promise<void> {
  // Snapshot the current first mailbox page so an older ERA report is never
  // mistaken for the report created by this run.
  const mailbox = await openMailbox(page);
  const previousFilenames = await mailboxEraFilenames(mailbox);
  await page.locator("#era-tab-link").click();
  const table = page.locator("#multiple-list");
  await table.waitFor({ state: "visible", timeout: 30000 });
  // Jopari renders the table shell before its AJAX request populates tbody.
  // A visible table is therefore not a completed ERA result. DataTables adds
  // either a real result row or a visible empty-result row when loading ends.
  await table.locator("tbody tr").first().waitFor({ state: "visible", timeout: 60000 });
  await page.locator("#multiple-list_processing").waitFor({ state: "hidden", timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(250);

  const loadedRows = table.locator("tbody tr:not(:has(td.dataTables_empty))");
  const loadedCount = await loadedRows.count();
  await context.log({ level: "info", message: `Jopari ERA table loaded: ${loadedCount} record(s).`, eventName: "jopari_era_table_loaded" });
  const readyRows = table.locator("tbody tr").filter({ hasText: /Ready/i });
  const count = await readyRows.count();
  await context.log({ level: "info", message: `Jopari Ready ERA rows found: ${count}.`, eventName: "jopari_era_ready_count" });
  if (!count) { await context.log({ level: "info", message: "No new Jopari ERAs were ready after the ERA table finished loading.", eventName: "jopari_era_empty" }); return; }
  for (let index = 0; index < count; index += 1) {
    await readyRows.nth(index).locator('input[type="checkbox"]').check({ timeout: 15000 });
  }
  const selectedCount = await readyRows.locator('input[type="checkbox"]:checked').count();
  if (selectedCount !== count) throw new Error(`Jopari selected ${selectedCount} of ${count} Ready ERA row(s).`);
  await context.log({ level: "info", message: `Selected ${selectedCount} Jopari ERA row(s) for download.`, eventName: "jopari_era_selected" });
  await page.locator("#era_download").click();
  await context.log({ level: "info", message: `Requested a Jopari ERA ZIP for ${count} ready row(s); opening Mailbox.`, eventName: "jopari_era_requested" });
  await openMailbox(page);
  const newEraRow = await waitForNewMailboxEra(page, previousFilenames, context);
  const expectedName = (await newEraRow.locator(".data-mailbox-filename").getAttribute("title").catch(() => null))?.trim()
    || "jopari_era_download.zip";
  const filename = await saveDownload(page, () => newEraRow.locator("a:has(.fa-download)").click(), outputRoot, expectedName);
  await context.log({ level: "info", message: `Downloaded Jopari ERA package ${filename}.`, eventName: "jopari_era_downloaded" });
}

function mmDdYyyy(date: Date): string { return `${String(date.getMonth() + 1).padStart(2, "0")}/${String(date.getDate()).padStart(2, "0")}/${date.getFullYear()}`; }
async function fillDate(input: Locator, value: string): Promise<void> { await input.click(); await input.press("Control+A"); await input.fill(value); }

async function exportPayments(page: Page, outputRoot: string, lookbackDays: number, context: AutomationContext): Promise<{ rows: ExportRow[]; exportName: string }> {
  await page.locator("#search-tab-link").click();
  await page.locator("#searcheft-list").waitFor({ state: "visible", timeout: 30000 });
  const end = new Date(); const start = new Date(); start.setDate(end.getDate() - lookbackDays);
  await fillDate(page.locator("#srchEftPymtDateFrom"), mmDdYyyy(start));
  await fillDate(page.locator("#srchEftPymtDateTo"), mmDdYyyy(end));
  await page.locator("#search-eft-btn").click();
  await page.locator("#searcheft-list_processing").waitFor({ state: "hidden", timeout: 60000 }).catch(() => {});
  const exportLink = page.locator("#export");
  await exportLink.waitFor({ state: "visible", timeout: 30000 });
  await page.waitForFunction(() => {
    const href = document.querySelector<HTMLAnchorElement>("#export")?.getAttribute("href") ?? "";
    return href !== "#" && href.includes("f_fetchCheckJXls");
  }, undefined, { timeout: 30000 });

  const href = await exportLink.getAttribute("href");
  if (!href) throw new Error("Jopari Export link did not contain a workbook URL after search completed.");
  const exportUrl = new URL(href, page.url()).toString();
  await context.log({ level: "info", message: "Downloading the Jopari payment export through the authenticated session.", eventName: "jopari_export_request" });
  const response = await page.context().request.get(exportUrl, { timeout: 90000 });
  if (!response.ok()) throw new Error(`Jopari Excel export returned HTTP ${response.status()}.`);

  const headers = response.headers();
  const contentType = headers["content-type"]?.toLowerCase() ?? "";
  if (!contentType.includes("application/xls") && !contentType.includes("excel") && !contentType.includes("octet-stream")) {
    throw new Error(`Jopari Excel export returned unexpected content type "${contentType || "unknown"}".`);
  }
  const buffer = Buffer.from(await response.body());
  if (!buffer.length) throw new Error("Jopari Excel export returned an empty file.");
  const disposition = headers["content-disposition"] ?? "";
  const dispositionName = disposition.match(/filename\s*=\s*"?([^";]+)"?/i)?.[1]?.trim();
  const exportName = safe(dispositionName || "excelExport.xls");
  await fs.writeFile(path.join(outputRoot, exportName), buffer);
  const rows = await parseJopariExport(buffer);
  await context.log({ level: "info", message: `Exported ${rows.length} Jopari ACH/NON payment row(s).`, eventName: "jopari_export_downloaded" });
  return { rows, exportName };
}

async function searchAndDownloadPdf(page: Page, row: ExportRow, pdfFolder: string): Promise<string | null> {
  const useBatch = normalizeJopariIdentifier(row.eftCheckNumber) === "0";
  const checkInput = page.locator("#srchEfteft");
  const batchInput = page.locator("#srchEftbatchId, input[name='batchId']").first();
  await checkInput.fill(useBatch ? "" : row.eftCheckNumber);
  await batchInput.fill(useBatch ? row.batchId : "").catch(() => {});
  await page.locator("#search-eft-btn").click();
  await page.locator("#searcheft-list_processing").waitFor({ state: "hidden", timeout: 60000 }).catch(() => {});
  const result = page.locator("#searcheft-list tbody tr").filter({ hasText: useBatch ? row.batchId : row.eftCheckNumber }).first();
  if (!(await result.isVisible({ timeout: 10000 }).catch(() => false))) return null;
  const popupPromise = page.waitForEvent("popup", { timeout: 30000 });
  await result.locator("a.check-image").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded", { timeout: 60000 }).catch(() => {});
  const response = await page.context().request.get(popup.url());
  if (!response.ok()) throw new Error(`Jopari EOB PDF returned HTTP ${response.status()}.`);
  const pdf = Buffer.from(await response.body());
  if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("Jopari EOB response was not a PDF.");
  const filename = `${safe(row.eftCheckNumber || row.batchId)}_${safe(row.payDate.replace(/\//g, "-"))}.pdf`;
  await fs.writeFile(path.join(pdfFolder, filename), pdf);
  await popup.close().catch(() => {});
  return filename;
}

async function runJopari(input: RunInput, context: AutomationContext): Promise<void> {
  const outputRoot = path.join(getJobDataPath(context.jobId, "outputs"), `jopari-${context.jobId}`);
  const pdfFolder = path.join(outputRoot, "EOB_PDFs");
  await fs.mkdir(pdfFolder, { recursive: true });
  const session = await launchAutomationBrowser();
  const page = session.context.pages()[0] ?? await session.context.newPage();
  const audit: JopariPaymentRow[] = [];
  try {
    await login(page, input.credentials, context);
    await phaseOne(page, outputRoot, context);
    const { rows } = await exportPayments(page, outputRoot, input.credentials.lookbackDays, context);
    const unique = rows.filter((row) => {
      if (!existsInControlLog(row, input.control)) return true;
      audit.push({ ...row, comparison: "Existing", searchResult: "Skipped", downloadStatus: "Skipped", filename: "", message: "Matched normalized Check number or Batch ID in Control Log." });
      return false;
    });
    await context.emit({ type: "progress", completed: 0, total: Math.max(unique.length, 1) });
    for (let index = 0; index < unique.length; index += 1) {
      const row = unique[index];
      if (context.isCancelled?.()) break;
      try {
        const filename = await searchAndDownloadPdf(page, row, pdfFolder);
        audit.push({ ...row, comparison: "Unique", searchResult: filename ? "Found" : "Not found", downloadStatus: filename ? "Downloaded" : "Not downloaded", filename: filename ?? "", message: filename ? "EOB PDF downloaded." : "No matching Jopari payment row or image was found." });
      } catch (error) {
        audit.push({ ...row, comparison: "Unique", searchResult: "Error", downloadStatus: "Error", filename: "", message: error instanceof Error ? error.message : String(error) });
      }
      await context.emit({ type: "progress", completed: index + 1, total: Math.max(unique.length, 1) });
    }
    const auditWorkbook = await createJopariAuditWorkbook(audit);
    await fs.writeFile(path.join(outputRoot, "jopari_comparison_audit.xlsx"), auditWorkbook);
    const zip = await createStoredZipFromFolder(outputRoot, `JopariPaymentEobDownloads/${dateStamp()}/run-01`);
    const zipName = `JopariPaymentEobDownloads_${dateStamp()}_run-01.zip`;
    await context.emit(event(zipName, zip, "application/zip"));
    await context.log({ level: "info", message: `Jopari workflow completed. ${audit.length} payment row(s) recorded in the audit Excel workbook.`, eventName: "jopari_complete" });
  } finally {
    await page.locator("#logout-link").click({ timeout: 5000 }).catch(() => {});
    await session.browser?.close().catch(() => {});
  }
}

export function createJopariRunner(): AutomationRunner<PaymentEobRunInput> {
  return {
    workflowId: "payment-eob-download", portalId: jopariConfig.id, name: jopariConfig.name,
    validateInput(value) {
      if (!(value instanceof FormData)) throw new Error("Payment EOB input must be multipart form data.");
      return { credentialExcel: requiredFile(value, "credentialExcel", "Credential Excel"), referenceExcel: requiredFile(value, "referenceExcel", "Control Log") };
    },
    async run(value, context) {
      const credentials = await readJopariCredentials(value.credentialExcel);
      const control = await readJopariControlLog(value.referenceExcel!);
      await runJopari({ credentials, control }, context);
    },
  };
}
