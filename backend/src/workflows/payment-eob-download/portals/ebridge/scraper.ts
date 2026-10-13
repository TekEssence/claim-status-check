import { paymentFilename } from "../../filename";
import fs from "node:fs/promises";
import path from "node:path";
import type { Download, Frame, Page } from "playwright-core";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { getJobDataPath } from "@/backend/src/core/storage";
import type { AutomationContext, AutomationRunner } from "../../../types";
import type { PaymentEobRunInput } from "../../types";
import { createStoredZipFromFolder } from "../availity-remittance/zip";
import { ebridgeConfig } from "./config";
import { readEbridgeCredentials, type EbridgeCredentials } from "./input";
import { createEbridgeWorkbook, type EbridgeDocumentRow } from "./output";

const INCLUDED_DOCUMENT_TYPES = new Set(["INPATIENT BILLINGS", "FACESHEETS"]);

type EbridgeRuntimeRow = EbridgeDocumentRow & {
  resultId: string;
  sourceIndex: number;
};

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) throw new Error(`${label} is required.`);
  return value;
}

function todayYyyyMmDd(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function safePart(value: string): string {
  return value.trim().replace(/[<>:"/\\|?*\x00-\x1f]/g, "_") || "ebridge";
}

function normalizeDocumentType(value: string): string {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function documentTypeFolder(value: string): string {
  const normalized = normalizeDocumentType(value);
  if (normalized === "FACESHEETS") return "Facesheets";
  if (normalized === "INPATIENT BILLINGS") return "InPatient billing";
  return safePart(value);
}

function cssAttributeValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function rowLabel(row: EbridgeRuntimeRow): string {
  return `row ${row.rowNumber} (${row.documentType}${row.name ? ` - ${row.name}` : ""})`;
}

async function logEbridgeStep(context: AutomationContext, row: EbridgeRuntimeRow, message: string, level: "info" | "warn" | "error" = "info"): Promise<void> {
  await context.log({ level, message: `eBridge ${rowLabel(row)}: ${message}`, eventName: "ebridge_download_step" });
}

async function fillLegacyInput(target: Page | Frame, selector: string, value: string): Promise<void> {
  const input = target.locator(selector).first();
  await input.waitFor({ state: "visible", timeout: 30000 });
  await input.click();
  await input.press("Control+A").catch(() => {});
  await input.press("Backspace").catch(() => {});
  await input.fill(value);
  await input.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });
}

async function dismissEbridgeModal(target: Page | Frame): Promise<void> {
  const modal = target.locator(".modalWrapper:visible, .modal:visible, [class*='modal']:visible").first();
  if (!await modal.isVisible({ timeout: 1000 }).catch(() => false)) return;
  const ok = target.locator("button, input[type='button'], .modalWrapper *").filter({ hasText: /^\s*(Okay|Ok)\s*$/i }).first();
  if (await ok.isVisible({ timeout: 3000 }).catch(() => false)) {
    await ok.click({ force: true }).catch(async () => ok.evaluate((element) => (element as HTMLElement).click()));
    await modal.waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  }
}

async function login(page: Page, credentials: EbridgeCredentials, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Opening eBridge login page.", eventName: "ebridge_login_open" });
  await page.goto(credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  if (await page.locator("input.btnBorderGreen[value='Sign in']").isVisible({ timeout: 5000 }).catch(() => false)) {
    await page.locator("input.btnBorderGreen[value='Sign in']").click();
  } else if (!/\/ebridge\/3\.0\/default\.aspx/i.test(page.url())) {
    await page.goto("https://app.ebridge.com/ebridge/3.0/default.aspx", { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  await fillLegacyInput(page, "#tbUserName", credentials.username);
  await fillLegacyInput(page, "#tbPassword", credentials.password);
  await fillLegacyInput(page, "#tbFileCabinet", credentials.fileCabinet);
  await Promise.all([
    page.waitForURL(/\/app\/main\.html/i, { timeout: 90000 }).catch(() => undefined),
    page.locator("#btnLogin").click(),
  ]);
  await page.locator("#btnNavRetrieve, li.nav_buttons").filter({ hasText: /^\s*Retrieve\s*$/i }).first().waitFor({ state: "visible", timeout: 90000 });
  await context.log({ level: "info", message: "eBridge login completed.", eventName: "ebridge_login_complete" });
}

async function findSearchFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      const name = candidate.name().toLowerCase();
      const url = candidate.url().toLowerCase();
      return name === "ifmain" || url.includes("retrieve/search.html") || url.includes("/search.html");
    });
    if (frame && await frame.locator("#tStartDate").isVisible({ timeout: 500 }).catch(() => false)) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error("eBridge Retrieve search frame did not load the Scan Date fields.");
}

async function openRetrieveSearch(page: Page, context: AutomationContext): Promise<Frame> {
  const retrieve = page.locator("#btnNavRetrieve, li.nav_buttons").filter({ hasText: /^\s*Retrieve\s*$/i }).first();
  await retrieve.click();
  const searchFrame = await findSearchFrame(page);
  await dismissEbridgeModal(searchFrame);
  await searchFrame.locator("#tStartDate").waitFor({ state: "visible", timeout: 60000 });
  await searchFrame.locator("#tEndDate").waitFor({ state: "visible", timeout: 60000 });
  await searchFrame.locator("#btnSearchF").waitFor({ state: "visible", timeout: 60000 });
  await context.log({ level: "info", message: "eBridge Retrieve search page opened.", eventName: "ebridge_retrieve_opened" });
  return searchFrame;
}

async function searchByScanDate(searchFrame: Frame, credentials: EbridgeCredentials, context: AutomationContext): Promise<void> {
  await dismissEbridgeModal(searchFrame);
  await fillLegacyInput(searchFrame, "#tStartDate", credentials.startDate);
  await dismissEbridgeModal(searchFrame);
  await fillLegacyInput(searchFrame, "#tEndDate", credentials.endDate);
  await context.log({ level: "info", message: `Searching eBridge Scan Date ${credentials.startDate} through ${credentials.endDate}.`, eventName: "ebridge_search_start" });
  await dismissEbridgeModal(searchFrame);
  await searchFrame.locator("#btnSearchF").click();
  await searchFrame.waitForURL(/\/retrieve\/results\.html/i, { timeout: 90000 }).catch(() => {});
  await dismissEbridgeModal(searchFrame);
  await searchFrame.locator("#resultsTable #resultsBody tr.results_row").first().waitFor({ state: "visible", timeout: 90000 });
}

async function findResultsFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => {
      const name = candidate.name().toLowerCase();
      const url = candidate.url().toLowerCase();
      return name === "ifmain" || url.includes("retrieve/results.html") || url.includes("/results.html");
    });
    if (frame && await frame.locator("#resultsTable #resultsBody tr.results_row").first().isVisible({ timeout: 500 }).catch(() => false)) return frame;
    await page.waitForTimeout(500);
  }
  throw new Error("eBridge results frame is not available.");
}

async function readResultRows(searchFrame: Frame): Promise<EbridgeRuntimeRow[]> {
  const rows = searchFrame.locator("#resultsTable #resultsBody tr.results_row");
  const result: EbridgeRuntimeRow[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const resultId = await row.getAttribute("resultid") || await row.getAttribute("id") || "";
    const cells = (await row.locator("td").allInnerTexts()).map((value) => value.replace(/\s+/g, " ").trim());
    const documentTypeIndex = cells.findIndex((cell) => INCLUDED_DOCUMENT_TYPES.has(normalizeDocumentType(cell)));
    const documentType = documentTypeIndex >= 0 ? cells[documentTypeIndex] : cells[3] ?? "";
    if (!INCLUDED_DOCUMENT_TYPES.has(normalizeDocumentType(documentType))) continue;
    const nameIndex = Math.max(0, documentTypeIndex - 2);
    const dateIndex = Math.max(0, documentTypeIndex - 1);
    result.push({
      rowNumber: cells[0] || String(result.length + 1),
      resultId,
      sourceIndex: index,
      name: cells[nameIndex] || "",
      date: cells[dateIndex] || "",
      documentType,
      insuranceCompany: cells[documentTypeIndex + 1] || "",
      access: cells[documentTypeIndex + 2] || "",
      serviceLocation: cells[documentTypeIndex + 3] || "",
      batchLabel: cells[documentTypeIndex + 4] || "",
      indexedDate: cells[documentTypeIndex + 5] || "",
      type: cells[documentTypeIndex + 6] || "",
      pages: cells[documentTypeIndex + 7] || "",
      filename: "",
      status: "Pending",
      message: "",
    });
  }
  return result;
}

async function waitForViewerReady(page: Page, context: AutomationContext, row: EbridgeRuntimeRow): Promise<void> {
  await logEbridgeStep(context, row, "waiting for viewer download toolbar.");
  await page.locator("#toolbar #btnDownload, #btnDownload").first().waitFor({ state: "visible", timeout: 90000 });
  await logEbridgeStep(context, row, "download toolbar is visible; waiting for page counter/rendered document.");
  await page.waitForFunction(() => {
    const counter = (document.querySelector<HTMLInputElement>("#tbCurrPage")?.value || "").trim();
    const footer = (document.querySelector("#footerInfo")?.textContent || "").trim();
    const progress = document.querySelector<HTMLElement>("#progressbar_main");
    const progressHidden = !progress || getComputedStyle(progress).display === "none";
    const firstPageReady = !!document.querySelector("img.page[src^='blob:'], img.page[src^='data:']");
    return /^\d+\s+of\s+\d+$/i.test(counter) && progressHidden && (firstPageReady || /pages?\s+loaded/i.test(footer));
  }, undefined, { timeout: 90000 });
  await page.waitForFunction(() => {
    const counter = (document.querySelector<HTMLInputElement>("#tbCurrPage")?.value || "").trim();
    const firstPage = document.querySelector<HTMLImageElement>("img.page[src^='blob:'], img.page[src^='data:']");
    return /^\d+\s+of\s+\d+$/i.test(counter) && !!firstPage?.complete;
  }, undefined, { timeout: 30000 }).catch(() => {});
  const state = await page.evaluate(() => ({
    counter: (document.querySelector<HTMLInputElement>("#tbCurrPage")?.value || "").trim(),
    footer: (document.querySelector("#footerInfo")?.textContent || "").trim(),
    downloadHidden: !!document.querySelector<HTMLElement>("#btnDownload") && getComputedStyle(document.querySelector<HTMLElement>("#btnDownload")!).display === "none",
    firstPageSrc: document.querySelector<HTMLImageElement>("img.page")?.src?.slice(0, 40) || "",
  })).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
  await logEbridgeStep(context, row, `viewer ready state: ${JSON.stringify(state)}.`);
  await page.waitForTimeout(1000);
}

async function clickDownloadPdfMenuItem(page: Page, context: AutomationContext, row: EbridgeRuntimeRow): Promise<boolean> {
  await logEbridgeStep(context, row, "waiting for Download PDF menu item.");
  const menuItem = page.locator("#downloadSubToolBar span[onclick=\"DownloadDocument(false);\"]").first();
  await menuItem.waitFor({ state: "visible", timeout: 15000 });
  await page.waitForTimeout(750);
  const menuItems = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>("#downloadSubToolBar span")]
    .map((element) => ({ text: element.innerText.trim(), onclick: element.getAttribute("onclick"), visible: element.offsetParent !== null }))
    .slice(0, 10)).catch(() => []);
  await logEbridgeStep(context, row, `visible download menu items: ${JSON.stringify(menuItems)}.`);
  const clicked = await page.evaluate(() => {
    const item = document.querySelector<HTMLElement>("#downloadSubToolBar span[onclick=\"DownloadDocument(false);\"]");
    if (!item) return false;
    item.scrollIntoView({ block: "center", inline: "center" });
    for (const type of ["mouseover", "mousedown", "mouseup", "click"]) {
      item.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    item.click();
    if (typeof DownloadDocument === "function") DownloadDocument(false);
    return true;
  });
  await logEbridgeStep(context, row, clicked ? "clicked Download PDF menu item." : "Download PDF menu item was not found at click time.", clicked ? "info" : "warn");
  return clicked;
}

async function clickViewerDownload(page: Page, context: AutomationContext, row: EbridgeRuntimeRow): Promise<Download | null> {
  await waitForViewerReady(page, context, row);
  const downloadPromise = page.waitForEvent("download", { timeout: 90000 }).catch(() => null);
  const selectors = [
    "#btnDownload",
    ".toolbarBtn[title='Download']",
    "[title='Download']",
    "button[aria-label='Download']",
    "cr-icon-button[aria-label='Download']",
    "cr-icon-button#download",
  ];
  for (const frame of page.frames()) {
    for (const selector of selectors) {
      const button = frame.locator(selector).first();
      if (!(await button.isVisible({ timeout: 500 }).catch(() => false))) continue;
      await logEbridgeStep(context, row, `clicking viewer download toolbar button using selector ${selector}.`);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await logEbridgeStep(context, row, `download menu attempt ${attempt + 1}/2.`);
        await button.click({ force: true }).catch(async () => button.evaluate((element) => (element as HTMLElement).click()));
        if (await clickDownloadPdfMenuItem(page, context, row).catch(async (error) => {
          await logEbridgeStep(context, row, `Download PDF menu click failed: ${error instanceof Error ? error.message : String(error)}.`, "warn");
          return false;
        })) {
          await page.waitForFunction(() => {
            const candidates = [...document.querySelectorAll<HTMLElement>("a, button, div, li, span")];
            return !candidates.some((element) => element.innerText?.trim() === "Download PDF" && element.offsetParent !== null);
          }, undefined, { timeout: 3000 }).catch(() => {});
          await logEbridgeStep(context, row, "Download PDF click submitted; waiting for browser download event.");
          return downloadPromise;
        }
        await page.waitForTimeout(1000);
      }
      return downloadPromise;
    }
  }
  return null;
}

async function readViewerDownloadFrame(page: Page, context: AutomationContext, row: EbridgeRuntimeRow): Promise<Buffer | null> {
  await logEbridgeStep(context, row, "checking eBridge hidden download iframe fallback.");
  const src = await page.waitForFunction(() => {
    const iframe = document.querySelector<HTMLIFrameElement>("iframe#download");
    return iframe?.getAttribute("src") || "";
  }, undefined, { timeout: 15000 }).then((handle) => handle.jsonValue()).catch(() => "");
  if (typeof src !== "string" || !src.trim()) {
    await logEbridgeStep(context, row, "hidden download iframe did not receive a URL.", "warn");
    return null;
  }
  const url = new URL(src, page.url()).href;
  await logEbridgeStep(context, row, `hidden download iframe URL detected: ${url.slice(0, 160)}.`);
  const response = await page.request.get(url).catch(() => null);
  if (!response?.ok()) {
    await logEbridgeStep(context, row, `hidden iframe request failed with status ${response?.status() ?? "none"}.`, "warn");
    return null;
  }
  const body = Buffer.from(await response.body());
  await logEbridgeStep(context, row, `hidden iframe response size: ${body.length} bytes.`);
  return body.length ? body : null;
}

async function readPdfFromViewer(page: Page, context?: AutomationContext, row?: EbridgeRuntimeRow): Promise<Buffer | null> {
  const candidates = new Set<string>();
  for (const frame of page.frames()) {
    if (/\.pdf(?:[?#]|$)|viewer\.html/i.test(frame.url())) candidates.add(frame.url());
    const urls = await frame.locator("iframe[src], embed[src], object[data]").evaluateAll((elements) => elements.map((element) => {
      const raw = element.getAttribute("src") || element.getAttribute("data") || "";
      try { return raw ? new URL(raw, document.baseURI).href : ""; } catch { return ""; }
    })).catch(() => []);
    urls.filter(Boolean).forEach((url) => candidates.add(url));
  }
  if (context && row) await logEbridgeStep(context, row, `PDF fallback candidates: ${candidates.size}.`);
  for (const url of candidates) {
    const response = await page.request.get(url).catch(() => null);
    if (!response?.ok()) continue;
    const body = Buffer.from(await response.body());
    if (body.subarray(0, 5).equals(Buffer.from("%PDF-"))) return body;
  }
  return null;
}

async function openAndDownloadDocument(page: Page, searchFrame: Frame, row: EbridgeRuntimeRow, folder: string, context: AutomationContext, group?: string): Promise<string> {
  await logEbridgeStep(context, row, "starting row download.");
  await dismissEbridgeModal(searchFrame);
  const portalRow = row.resultId
    ? searchFrame.locator(`#resultsTable #resultsBody tr[resultid='${cssAttributeValue(row.resultId)}']`).first()
    : searchFrame.locator("#resultsTable #resultsBody tr.results_row").nth(row.sourceIndex);
  const viewerTrigger = portalRow.locator("img[src*='view.gif'], [title*='View' i], [title*='Open' i], img, a").first();
  const popupPromise = page.waitForEvent("popup", { timeout: 30000 }).catch(() => null);
  await viewerTrigger.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  await logEbridgeStep(context, row, "clicking result view icon.");
  await viewerTrigger.click({ timeout: 30000 });
  const popup = await popupPromise;
  const viewer = popup ?? page;
  await logEbridgeStep(context, row, popup ? `viewer popup opened: ${viewer.url().slice(0, 160)}.` : "no popup event; using current page as viewer.", popup ? "info" : "warn");
  await viewer.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  const documentFolder = path.join(folder, documentTypeFolder(row.documentType));
  await fs.mkdir(documentFolder, { recursive: true });
  const filename = await paymentFilename(documentFolder, {
    group,
    payer: row.insuranceCompany || row.documentType,
    mode: row.documentType,
    number: row.batchLabel || row.rowNumber,
    date: row.date || row.indexedDate,
  });
  const outputPath = path.join(documentFolder, filename);
  try {
    const download = await clickViewerDownload(viewer, context, row);
    if (download) {
      await logEbridgeStep(context, row, `browser download event received; saving as ${filename}.`);
      await download.saveAs(outputPath);
    } else {
      await logEbridgeStep(context, row, "browser download event was not received; trying fallbacks.", "warn");
      const pdf = await readViewerDownloadFrame(viewer, context, row) ?? await readPdfFromViewer(viewer, context, row);
      if (!pdf) throw new Error("eBridge viewer opened, but the PDF download/content could not be accessed.");
      await fs.writeFile(outputPath, pdf);
    }
    await logEbridgeStep(context, row, `saved PDF ${filename}.`);
  } finally {
    await logEbridgeStep(context, row, "closing viewer popup.");
    if (popup) await popup.close().catch(() => {});
  }
  return filename;
}

async function runEbridge(credentials: EbridgeCredentials, context: AutomationContext): Promise<void> {
  const rootName = `EbridgePaymentDocumentDownloads_${todayYyyyMmDd()}_${safePart(context.jobId)}`;
  const root = path.join(getJobDataPath(context.jobId, "outputs"), rootName);
  const pdfFolder = path.join(root, "PDFs");
  await fs.mkdir(pdfFolder, { recursive: true });
  const audit: EbridgeDocumentRow[] = [];
  const session = await launchAutomationBrowser();
  const page = session.context.pages()[0] ?? await session.context.newPage();
  try {
    page.setDefaultTimeout(30000);
    await login(page, credentials, context);
    if (context.isCancelled?.()) return;
    const searchFrame = await openRetrieveSearch(page, context);
    await searchByScanDate(searchFrame, credentials, context);
    const rows = await readResultRows(await findResultsFrame(page));
    audit.push(...rows);
    await context.log({ level: "info", message: `eBridge found ${rows.length} included document(s): INPATIENT BILLINGS and Facesheets.`, eventName: "ebridge_results_loaded" });
    await context.emit({ type: "progress", completed: 0, total: rows.length });
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (context.isCancelled?.()) {
        row.status = "Cancelled";
        continue;
      }
      try {
        row.filename = await openAndDownloadDocument(page, await findResultsFrame(page), row, pdfFolder, context, credentials.clientName);
        row.status = "Downloaded";
        row.message = "Downloaded from eBridge viewer.";
      } catch (error) {
        row.status = "Failed";
        row.message = error instanceof Error ? error.message : String(error);
        await context.log({ level: "error", message: `eBridge row ${row.rowNumber} (${row.documentType}) failed: ${row.message}`, eventName: "ebridge_download_failed" });
      }
      await context.emit({ type: "progress", completed: index + 1, total: rows.length });
    }
  } finally {
    try {
      await fs.writeFile(path.join(root, "ebridge_download_status.xlsx"), await createEbridgeWorkbook(audit));
      const bundle = await createStoredZipFromFolder(root, rootName);
      await context.emit({ type: "file_download", filename: `${rootName}.zip`, base64: bundle.toString("base64"), mimeType: "application/zip" });
    } finally {
      await session.browser?.close().catch(() => {});
    }
  }
  if (context.isCancelled?.()) {
    await context.emit({ type: "cancelled", message: "eBridge stopped. Partial outputs were saved." });
    return;
  }
  const failed = audit.filter((row) => row.status === "Failed").length;
  if (failed) throw new Error(`eBridge finished with ${failed} failed document download(s). Partial outputs were saved; review the status workbook and logs.`);
  await context.log({ level: "info", message: `eBridge completed with ${audit.length} downloaded document(s).`, eventName: "ebridge_complete" });
}

export function createEbridgeRunner(): AutomationRunner<PaymentEobRunInput> {
  return {
    workflowId: "payment-eob-download",
    portalId: ebridgeConfig.id,
    name: ebridgeConfig.name,
    validateInput(value) {
      if (!(value instanceof FormData)) throw new Error("eBridge input must be multipart form data.");
      return { credentialExcel: requireFile(value, "credentialExcel", "Credential Excel") };
    },
    async run(input, context) {
      await runEbridge(await readEbridgeCredentials(input.credentialExcel), context);
    },
  };
}
