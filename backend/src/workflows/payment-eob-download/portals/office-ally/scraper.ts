import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { getJobDataPath } from "@/backend/src/core/storage";
import type { AutomationContext, AutomationRunner } from "../../../types";
import type { PaymentEobRunInput } from "../../types";
import { createStoredZipFromFolder } from "../availity-remittance/zip";
import { officeAllyConfig } from "./config";
import { readOfficeAllyCredentials, type OfficeAllyCredentials } from "./input";
import { createOfficeAllyWorkbook, saveOriginalZip, type OfficeAllyReport } from "./output";

async function dismissPopup(page: Page): Promise<void> {
  const close = page.locator('#pendo-guide-container button[aria-label="Close"]');
  if (await close.isVisible()) await close.click({ timeout: 5000 });
}

export async function loginOfficeAlly(page: Page, credentials: OfficeAllyCredentials): Promise<void> {
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.locator("#username").fill(credentials.username);
  await page.locator("#password").fill(credentials.password);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const reportsLink = page.getByRole("link", { name: "Download EOB / ERA 835", exact: true });
  await reportsLink.waitFor({ state: "visible", timeout: 90000 });
  await dismissPopup(page);
  await reportsLink.click();
  await page.locator("#lstReportBy").waitFor({ state: "visible", timeout: 60000 });
}

export async function loadOfficeAllyReports(page: Page, date: string): Promise<OfficeAllyReport[]> {
  await dismissPopup(page);
  const [month, day, year] = date.split("/");
  await page.locator("#lstReportBy").selectOption("date");
  await page.locator("#lstReportType").selectOption("0");
  await page.locator("#txtMonth").fill(month);
  await page.locator("#txtDay").fill(day);
  await page.locator("#txtYear").fill(year);
  // Remove only the previous results, so a stale date can never be recorded
  // while the portal is submitting the next Daily report.
  await page.locator("#divReport").evaluate(element => { element.innerHTML = ""; });
  await page.locator("#Button1").click();
  await page.waitForFunction(expected => {
    const text = document.querySelector("#divReport")?.textContent?.replace(/\s+/g, " ") ?? "";
    const match = text.match(/Daily EOB\s*\/\s*ERA 835 Reports for\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s*-\s*\[Report Type\s*=\s*All\]/i);
    return Boolean(match && `${Number(match[1])}/${Number(match[2])}/${match[3]}` === expected);
  }, date, { timeout: 60000 });
  const rows = await page.locator('#divReport tr[id^="dnl_"]').evaluateAll(elements => elements.map(element =>
    Array.from(element.children).map(cell => cell.textContent?.trim() ?? ""),
  ));
  return rows.map(cells => {
    if (cells.length !== 7 || !cells[2] || !cells[3] || !cells[4]) throw new Error("Office Ally returned an unexpected report row layout.");
    if (cells[0].split("/").map(Number).join("/") !== date) throw new Error("Office Ally returned a report outside the requested date.");
    return { date: cells[0], reportType: cells[1], fileId: cells[2], fileName: cells[3], eobId: cells[4], records: cells[5], status: "Pending" };
  });
}

export async function downloadOfficeAllyReport(page: Page, index: number, row: OfficeAllyReport, folder: string): Promise<void> {
  const link = page.locator('#divReport tr[id^="dnl_"]').nth(index).getByRole("link", { name: "VIEW", exact: true });
  // The supplied link uses target=_new. Keeping the download on this page
  // gives one download event without leaving an extra blank tab per file.
  await link.evaluate(element => element.setAttribute("target", "_self"));
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 90000 }),
    link.click(),
  ]);
  try {
    const failure = await download.failure();
    if (failure) throw new Error("Office Ally download failed before it could be saved.");
    const filename = download.suggestedFilename();
    if (filename !== row.fileName) throw new Error("The download filename differs from the report filename; no file was renamed or saved.");
    const stream = await download.createReadStream();
    if (!stream) throw new Error("Office Ally download could not be read.");
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    row.status = await saveOriginalZip(folder, filename, Buffer.concat(chunks));
  } finally {
    await download.delete().catch(() => {});
  }
}

async function runOfficeAlly(credentials: OfficeAllyCredentials, context: AutomationContext): Promise<void> {
  const folder = path.join(getJobDataPath(context.jobId, "outputs"), "OfficeAllyPaymentEobDownloads");
  await fs.mkdir(folder, { recursive: true });
  const audit: OfficeAllyReport[] = [];
  let failedDates = 0;
  let completedDates = 0;
  const session = await launchAutomationBrowser();
  const page = session.context.pages()[0] ?? await session.context.newPage();
  try {
    await context.log({ level: "info", message: `Office Ally: processing ${credentials.dates[0]} through ${credentials.dates.at(-1)} (Daily / All).`, eventName: "office_ally_start" });
    await loginOfficeAlly(page, credentials);
    await context.emit({ type: "progress", completed: 0, total: credentials.dates.length });
    for (const date of credentials.dates) {
      if (context.isCancelled?.()) break;
      try {
        const rows = await loadOfficeAllyReports(page, date);
        audit.push(...rows);
        await context.log({ level: "info", message: `${date}: ${rows.length} Office Ally report file(s).`, eventName: "office_ally_reports" });
        for (let index = 0; index < rows.length; index++) {
          const row = rows[index];
          if (context.isCancelled?.()) { row.status = "Cancelled"; continue; }
          try {
            await downloadOfficeAllyReport(page, index, row, folder);
          } catch (error) {
            row.status = "Failed";
            await context.log({ level: "error", message: `${date}, File ID ${row.fileId}: ${error instanceof Error ? error.message : "Download failed."}`, eventName: "office_ally_download_failed" });
          }
        }
      } catch {
        failedDates++;
        await context.log({ level: "error", message: `Office Ally could not load or validate reports for ${date}. Rerun this date.`, eventName: "office_ally_date_failed" });
      }
      completedDates++;
      await context.emit({ type: "progress", completed: completedDates, total: credentials.dates.length });
    }
  } finally {
    try {
      await fs.writeFile(path.join(folder, "office_ally_download_status.xlsx"), await createOfficeAllyWorkbook(audit));
      const bundle = await createStoredZipFromFolder(folder, "OfficeAllyPaymentEobDownloads");
      await context.emit({ type: "file_download", filename: "OfficeAllyPaymentEobDownloads.zip", base64: bundle.toString("base64"), mimeType: "application/zip" });
    } finally {
      if (session.browser) await session.browser.close().catch(() => {});
      else await page.close().catch(() => {});
    }
  }
  if (context.isCancelled?.()) {
    await context.emit({ type: "cancelled", message: "Office Ally stopped. Partial outputs were saved." });
    return;
  }
  const failedFiles = audit.filter(row => row.status === "Failed").length;
  if (failedDates || failedFiles) throw new Error(`Office Ally finished with ${failedDates} failed date(s) and ${failedFiles} failed file(s). Partial outputs were saved; review the status workbook and logs.`);
  await context.log({ level: "info", message: `Office Ally completed: ${audit.length} report row(s) across ${completedDates} date(s).`, eventName: "office_ally_complete" });
}

export function createOfficeAllyRunner(): AutomationRunner<PaymentEobRunInput> {
  return {
    workflowId: "payment-eob-download", portalId: officeAllyConfig.id, name: officeAllyConfig.name,
    validateInput(value) {
      if (!(value instanceof FormData)) throw new Error("Office Ally input must be multipart form data.");
      const credentialExcel = value.get("credentialExcel");
      if (!(credentialExcel instanceof File) || !credentialExcel.size) throw new Error("Credential Excel is required.");
      return { credentialExcel };
    },
    async run(input, context) {
      await runOfficeAlly(await readOfficeAllyCredentials(input.credentialExcel), context);
    },
  };
}
