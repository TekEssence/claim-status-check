import fs from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { getJobDataPath } from "@/backend/src/core/storage";
import type { AutomationContext, AutomationRunner } from "../../../types";
import type { PaymentEobRunInput } from "../../types";
import { loginToWaystarClaimStatus } from "../../../claim-status/portals/waystar/portal";
import { createStoredZipFromFolder } from "../availity-remittance/zip";
import { waystarPaymentEobConfig } from "./config";
import { isEligibleWaystarControlRow, normalizeAmount, normalizePaymentNumber, readWaystarControlLog, readWaystarPaymentCredentials } from "./input";
import { buildWaystarControlLog, buildWaystarSearchResults } from "./output-builder";
import type { WaystarControlLogRow, WaystarPaymentCredentials, WaystarPaymentRecord, WaystarSearchResult } from "./types";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) throw new Error(`${label} is required.`);
  return value;
}

function datePart(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function safePart(value: string): string { return value.trim().replace(/[<>:"/\\|?*]/g, "_") || "payment"; }

async function selectAccount(page: Page, credentials: WaystarPaymentCredentials, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: `Checking Waystar account selection for ${credentials.account}.`, eventName: "waystar_payment_account_check" });
  const current = page.locator(".header-account-search-text").first();
  await current.waitFor({ state: "visible", timeout: 60000 });
  const currentValue = (await current.inputValue().catch(() => "")).trim();
  if (currentValue.toLowerCase().includes(credentials.account.toLowerCase())) {
    await context.log({ level: "info", message: `Waystar account ${currentValue} is already selected.`, eventName: "waystar_payment_account_selected" });
    return;
  }

  await page.locator("#hdrAcctChildSearchLnk").click();
  const input = page.locator("#accountSearchChildModal .header-account-search-input").first();
  await input.fill(credentials.account);
  await page.locator("#accountSearchChildButton").click();
  const result = page.locator("#accountSearchChildModal a.change-account-link").filter({ hasText: credentials.account }).first();
  await result.waitFor({ state: "visible", timeout: 30000 });
  await Promise.all([page.waitForLoadState("networkidle").catch(() => {}), result.click()]);
  await page.locator("#changeSuccess, #accountName").first().waitFor({ state: "visible", timeout: 30000 }).catch(() => {});
  await context.log({ level: "info", message: `Waystar account selected: ${credentials.account}.`, eventName: "waystar_payment_account_selected" });
}

async function navigateToPayments(page: Page, context: AutomationContext): Promise<void> {
  await context.log({ level: "info", message: "Opening Claims Processing menu.", eventName: "waystar_payment_claims_menu" });
  const claims = page.locator(".header-menu > a, a").filter({ hasText: /^\s*Claims Processing\s*$/i }).first();
  await claims.waitFor({ state: "visible", timeout: 30000 });
  await claims.hover();
  const claimsMenu = claims.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' header-menu ')][1]");
  const flyout = claimsMenu.locator(".header-flyout").first();
  await flyout.waitFor({ state: "visible", timeout: 10000 });
  const remits = flyout.locator("a").filter({ hasText: /^\s*Remits\s*$/i }).first();
  await remits.waitFor({ state: "visible", timeout: 10000 });
  await remits.click();
  await context.log({ level: "info", message: "Claims Processing > Remits selected; waiting for the Remits submenu.", eventName: "waystar_payment_remits_menu" });

  const payments = page.locator('.header-flyout:visible a[href*="/Payments" i]').filter({ hasText: /^\s*Payments\s*$/i }).first();
  const paymentsVisible = await payments.waitFor({ state: "visible", timeout: 10000 }).then(() => true).catch(() => false);
  if (paymentsVisible) {
    await context.log({ level: "info", message: "Remits submenu opened; selecting Payments.", eventName: "waystar_payment_payments_select" });
    await Promise.all([page.waitForURL(/\/Payments(?:\?|$)/i, { timeout: 60000 }), payments.click()]);
  } else {
    await context.log({ level: "warn", message: "Payments submenu link remained hidden after selecting Remits; opening the Waystar Payments URL directly.", eventName: "waystar_payment_payments_fallback" });
    await page.goto("https://remits.zirmed.com/Payments?appid=13", { waitUntil: "domcontentloaded", timeout: 60000 });
  }
  await page.locator("#ulSearchOptions").waitFor({ state: "visible", timeout: 30000 });
  await context.log({ level: "info", message: "Waystar Payments page loaded.", eventName: "waystar_payment_page_loaded" });
}

async function searchPayment(page: Page, checkNumber: string, context: AutomationContext, rowNumber: number): Promise<WaystarPaymentRecord[]> {
  const viewOptions = page.locator("#SearchOptions_ViewOptions").first();
  await viewOptions.waitFor({ state: "visible", timeout: 30000 });
  await viewOptions.selectOption({ label: "All" }).catch(async () => {
    await viewOptions.selectOption("0");
  });
  const payment = page.locator("#SearchOptions_PaymentNum").first();
  await payment.waitFor({ state: "visible", timeout: 30000 });
  await payment.scrollIntoViewIfNeeded();
  await payment.click();
  await payment.press("Control+A").catch(() => {});
  await payment.press("Backspace").catch(() => {});
  await payment.pressSequentially(checkNumber, { delay: 80 });
  await payment.evaluate((element) => {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
    element.dispatchEvent(new Event("blur", { bubbles: true }));
  });
  const enteredPaymentNumber = await payment.inputValue();
  if (normalizePaymentNumber(enteredPaymentNumber) !== normalizePaymentNumber(checkNumber)) {
    throw new Error(`Waystar Payment # field did not retain check number ${checkNumber}; current value is "${enteredPaymentNumber}".`);
  }
  await page.locator("#SearchOptions_PayNumSearchType").selectOption("0");
  await context.log({ level: "info", message: `${checkNumber}: Payment # entered and Search Type set to Exact.`, eventName: "waystar_payment_filter_filled", rowIndex: rowNumber });
  const before = await page.locator("#paymentsTableGrid tbody").innerText().catch(() => "");
  const search = page.locator('#searchButton, #ulSearchOptions input[type="submit"][value="Search"], #btnSearch').first();
  await search.waitFor({ state: "visible", timeout: 30000 });
  await search.scrollIntoViewIfNeeded();
  await context.log({ level: "info", message: `${checkNumber}: clicking Search.`, eventName: "waystar_payment_search_click", rowIndex: rowNumber });
  await search.click();
  await page.waitForFunction((previous) => {
    const body = document.querySelector("#paymentsTableGrid tbody")?.textContent?.trim() ?? "";
    return body !== previous || /no results|returned no results/i.test(document.body.innerText);
  }, before, { timeout: 30000 }).catch(() => {});

  const rows = page.locator("#paymentsTableGrid tr.gridViewRow[data-paymentnumber]");
  const records: WaystarPaymentRecord[] = [];
  for (let index = 0; index < await rows.count(); index += 1) {
    const row = rows.nth(index);
    const paymentNumber = normalizePaymentNumber(await row.getAttribute("data-paymentnumber"));
    if (paymentNumber !== normalizePaymentNumber(checkNumber)) continue;
    records.push({
      paymentAmount: (await row.getAttribute("data-paymentamount"))?.trim() ?? "",
      paymentDate: (await row.getAttribute("data-paymentdate"))?.trim() ?? "",
      payer: (await row.getAttribute("data-payer"))?.trim() ?? "",
      type: (await row.getAttribute("data-type"))?.trim() ?? "",
      paymentNumber,
      rowIndex: index,
    });
  }
  await context.log({ level: "info", message: `${checkNumber}: search completed with ${records.length} exact Payment # result(s).`, eventName: "waystar_payment_search_results", rowIndex: rowNumber });
  return records;
}

async function revealViewEob(page: Page, row: Locator): Promise<Locator> {
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.click().catch(() => {});
  const action = page.locator("#paymentsTableGrid .gridActionMenu a, .gridActionMenu .innerGridActionDiv a").filter({ hasText: /^View EOB$/ }).first();
  if (await action.waitFor({ state: "visible", timeout: 5000 }).then(() => true).catch(() => false)) return action;

  const checkbox = row.locator("input.selectedRow, input[type='checkbox']").first();
  if (await checkbox.isVisible().catch(() => false)) await checkbox.check().catch(() => {});
  const viewMenu = page.getByRole("button", { name: /^View(?:\s|$)/i }).first()
    .or(page.locator("input[value='View'], a, button").filter({ hasText: /^\s*View\s*$/i }).first());
  await viewMenu.click();
  const menuAction = page.locator("a:visible, button:visible, [role='menuitem']:visible").filter({ hasText: /^\s*View EOB\s*$/i }).first();
  await menuAction.waitFor({ state: "visible", timeout: 10000 });
  return menuAction;
}

async function downloadEob(page: Page, record: WaystarPaymentRecord, folder: string): Promise<string> {
  const row = page.locator("#paymentsTableGrid tr.gridViewRow[data-paymentnumber]").nth(record.rowIndex);
  const action = await revealViewEob(page, row);
  const downloadPromise = page.waitForEvent("download", { timeout: 15000 }).catch(() => null);
  const popupPromise = page.context().waitForEvent("page", { timeout: 15000 }).catch(() => null);
  await action.click();
  const download = await downloadPromise;
  const popup = await popupPromise;
  const filename = `${safePart(record.paymentNumber)}_${safePart(record.paymentDate)}.pdf`;
  const outputPath = path.join(folder, filename);

  if (download) {
    await download.saveAs(outputPath);
  } else if (popup) {
    await popup.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
    const response = await popup.request.get(popup.url(), { headers: { accept: "application/pdf,*/*" } });
    if (!response.ok()) throw new Error(`Waystar EOB request returned HTTP ${response.status()}.`);
    const buffer = await response.body();
    if (!buffer.subarray(0, 5).equals(Buffer.from("%PDF-"))) throw new Error("Waystar View EOB did not return a PDF.");
    await fs.writeFile(outputPath, buffer);
    await popup.close().catch(() => {});
  } else {
    throw new Error("Waystar View EOB did not open or download a PDF.");
  }

  await page.locator("a.ui-dialog-titlebar-close").filter({ hasText: /close/i }).first().click().catch(() => {});
  return filename;
}

function baseResult(row: WaystarControlLogRow): WaystarSearchResult {
  return { clientName: row.clientName, inputCheckNumber: row.checkNumber, inputBatchTotalAmount: row.batchTotalAmount,
    searchResult: "NOT_FOUND", portalPaymentNumber: "", portalPaymentAmount: "", portalPaymentDate: "", portalPayer: "", portalType: "",
    amountMatch: "", pdfStatus: "NOT_DOWNLOADED", pdfFileName: "", finalResult: "NOT_FOUND", error: "" };
}

async function runJob(credentials: WaystarPaymentCredentials, headers: string[], allRows: WaystarControlLogRow[], context: AutomationContext): Promise<void> {
  const eligible = allRows.filter(isEligibleWaystarControlRow);
  const rootName = `WaystarPaymentEobDownloads_${datePart()}_${context.jobId}`;
  const root = path.join(getJobDataPath(context.jobId, "outputs"), rootName);
  const pdfFolder = path.join(root, "PDFs");
  await fs.mkdir(pdfFolder, { recursive: true });
  const results: WaystarSearchResult[] = [];
  const byRow = new Map<number, WaystarSearchResult>();
  let browser: Awaited<ReturnType<typeof launchAutomationBrowser>> | null = null;
  await context.emit({ type: "progress", completed: 0, total: eligible.length });
  try {
    browser = await launchAutomationBrowser();
    const page = browser.context.pages()[0] ?? await browser.context.newPage();
    page.setDefaultTimeout(30000);
    await context.log({ level: "info", message: "Opening Waystar and signing in.", eventName: "waystar_payment_login_start" });
    await loginToWaystarClaimStatus(page, credentials);
    await context.log({ level: "info", message: "Waystar authentication completed, including any security verification.", eventName: "waystar_payment_login_complete" });
    await selectAccount(page, credentials, context);
    await navigateToPayments(page, context);
    for (let index = 0; index < eligible.length; index += 1) {
      const input = eligible[index];
      const result = baseResult(input);
      try {
        await context.log({ level: "info", message: `Searching Waystar for payment ${input.checkNumber} (${index + 1} of ${eligible.length}).`, eventName: "waystar_payment_search_start", rowIndex: input.rowNumber });
        const matches = await searchPayment(page, input.checkNumber, context, input.rowNumber);
        const exact = matches.find((entry) => normalizeAmount(entry.paymentAmount) === normalizeAmount(input.batchTotalAmount));
        const portal = exact ?? matches[0];
        if (portal) Object.assign(result, { searchResult: "FOUND", portalPaymentNumber: portal.paymentNumber, portalPaymentAmount: portal.paymentAmount,
          portalPaymentDate: portal.paymentDate, portalPayer: portal.payer, portalType: portal.type, amountMatch: exact ? "YES" : "NO" });
        if (!portal) {
          result.error = "No Waystar payment matched the input check number.";
          await context.log({ level: "warn", message: `No Waystar payment found for ${input.checkNumber}.`, eventName: "waystar_payment_not_found", rowIndex: input.rowNumber });
        } else if (!exact) {
          result.searchResult = "AMOUNT_MISMATCH"; result.finalResult = "AMOUNT_MISMATCH";
          result.error = "Payment number matched, but Payment Amount did not equal Batch Total Amount.";
          await context.log({ level: "warn", message: `${input.checkNumber}: portal amount ${portal.paymentAmount} does not match input amount ${input.batchTotalAmount}.`, eventName: "waystar_payment_amount_mismatch", rowIndex: input.rowNumber });
        } else {
          try {
            await context.log({ level: "info", message: `${input.checkNumber}: payment and amount matched; downloading View EOB.`, eventName: "waystar_payment_download_start", rowIndex: input.rowNumber });
            result.pdfFileName = await downloadEob(page, exact, pdfFolder);
            result.pdfStatus = "DOWNLOAD_SUCCESS"; result.finalResult = "DOWNLOAD_SUCCESS";
            await context.log({ level: "info", message: `${input.checkNumber}: downloaded ${result.pdfFileName}.`, eventName: "waystar_payment_download_complete", rowIndex: input.rowNumber });
          } catch (error) {
            result.pdfStatus = "DOWNLOAD_FAILED"; result.finalResult = "DOWNLOAD_FAILED";
            result.error = error instanceof Error ? error.message : String(error);
          }
        }
      } catch (error) {
        result.searchResult = "ERROR"; result.finalResult = "ERROR";
        result.error = error instanceof Error ? error.message : String(error);
      }
      results.push(result); byRow.set(input.rowNumber, result);
      await context.log({ level: result.finalResult === "DOWNLOAD_SUCCESS" ? "info" : "warn", message: `${input.checkNumber}: ${result.finalResult}.`, eventName: "waystar_payment_eob_row_complete", rowIndex: input.rowNumber });
      await context.emit({ type: "progress", completed: index + 1, total: eligible.length });
    }
  } finally {
    await browser?.browser?.close().catch(() => {});
  }

  const searchName = `Waystar_Search_Results_${datePart()}.xlsx`;
  const controlName = `Waystar_Control_Log_Output_${datePart()}.xlsx`;
  await fs.writeFile(path.join(root, searchName), await buildWaystarSearchResults(results));
  await fs.writeFile(path.join(root, controlName), await buildWaystarControlLog(headers, allRows, byRow));
  await context.log({ level: "info", message: "Waystar Search Results and Control Log output workbooks created.", eventName: "waystar_payment_outputs_created" });
  const zip = await createStoredZipFromFolder(root, rootName);
  await context.emit({ type: "file_download", filename: `${rootName}.zip`, base64: zip.toString("base64"), mimeType: "application/zip" });
  await context.log({ level: "info", message: `Waystar output package ready: ${rootName}.zip.`, eventName: "waystar_payment_package_ready" });
}

export function createWaystarPaymentEobRunner(): AutomationRunner<PaymentEobRunInput> {
  return { workflowId: "payment-eob-download", portalId: waystarPaymentEobConfig.id, name: waystarPaymentEobConfig.name,
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("Payment EOB input must be multipart form data.");
      return { credentialExcel: requireFile(input, "credentialExcel", "Credential Excel"), referenceExcel: requireFile(input, "referenceExcel", "Control Log Excel") };
    },
    async run(input, context) {
      await context.log({ level: "info", message: "Reading Waystar credential workbook and Control Log.", eventName: "waystar_payment_input_start" });
      const credentials = await readWaystarPaymentCredentials(input.credentialExcel);
      const control = await readWaystarControlLog(input.referenceExcel!);
      const eligibleCount = control.rows.filter(isEligibleWaystarControlRow).length;
      await context.log({ level: "info", message: `Input validation completed. ${eligibleCount} row(s) with Source=Waystar and Entry Status=In-Process will be processed.`, eventName: "waystar_payment_input_complete" });
      await runJob(credentials, control.headers, control.rows, context);
    } };
}
