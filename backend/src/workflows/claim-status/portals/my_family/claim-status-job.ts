import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Locator, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { ScraperContext } from "../../types";
import { launchMyFamilyBrowser } from "./browser";
import { myFamilyConfig } from "./config";
import {
  normalizeCptCode,
  parseMyFamilyInput,
  readMyFamilyInputWorkbook,
  splitPatientName,
  type MyFamilyInputRow,
} from "./input";
import { createMyFamilyOutputWorkbookBuffer, type MyFamilyAuditRow, type MyFamilyOutputRow, type MyFamilyWorkbookState } from "./workbook";

type SearchResultRow = {
  claimNumber: string;
  memberName: string;
  providerName: string;
  providerClaimId: string;
  dateOfService: string;
  status: string;
  company: string;
  rowText: string;
};

type DetailFieldMap = Record<string, string>;

type ResolvedName = { firstName: string; lastName: string };

const OUTPUT_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Not part of myFamilyConfig.selectors, but tied to stable DOM/URL structure rather than
// to any particular field layout, so it's safe to keep local.
const CLAIM_LINK_SELECTOR = "a[href*='ClaimDetails.aspx']";

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function maskValue(value: string): string {
  const text = value.trim();
  if (text.length <= 4) return "****";
  return `${"*".repeat(text.length - 4)}${text.slice(-4)}`;
}

function normalizeComparableDate(value: string): string {
  const match = value.trim().match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (!match) return value.trim();
  const year = Number(match[3]) < 100 ? 2000 + Number(match[3]) : Number(match[3]);
  return `${year}-${String(Number(match[1])).padStart(2, "0")}-${String(Number(match[2])).padStart(2, "0")}`;
}

function normalizeName(value: string): string {
  return cleanText(value).toUpperCase().replace(/[.,]/g, "");
}

/**
 * Resolves the patient first/last name to search with. input.ts already splits a
 * combined "Patient Name" column (e.g. "Alaniz Acosta, Miguel") into
 * patientFirstName/patientLastName before this job ever sees the row, so this is mostly
 * a pass-through — it only falls back to re-splitting here as a safety net in case some
 * other combined-name column slips through with a header input.ts doesn't recognize.
 */
function resolvePatientName(inputRow: MyFamilyInputRow): ResolvedName {
  const existingFirst = cleanText(inputRow.patientFirstName || "");
  const existingLast = cleanText(inputRow.patientLastName || "");
  if (existingFirst && existingLast) {
    return { firstName: existingFirst, lastName: existingLast };
  }

  const raw = inputRow as unknown as Record<string, unknown>;
  const candidateKeys = ["patientName", "fullPatientName", "patientFullName", "Patient Name", "PatientName", "Member Name"];
  for (const key of candidateKeys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) {
      const split = splitPatientName(value);
      return {
        firstName: existingFirst || split.firstName,
        lastName: existingLast || split.lastName,
      };
    }
  }

  return { firstName: existingFirst, lastName: existingLast };
}

function baseOutputRow(inputRow: MyFamilyInputRow, botStatus: string, botMessage: string, resolvedName?: ResolvedName): MyFamilyOutputRow {
  const firstName = resolvedName?.firstName ?? inputRow.patientFirstName;
  const lastName = resolvedName?.lastName ?? inputRow.patientLastName;
  return {
    inputData: inputRow,
    inputRowId: inputRow.inputRowId,
    botStatus,
    botMessage,
    memberId: inputRow.memberId,
    patientFirstName: firstName,
    patientLastName: lastName,
    dos: inputRow.dos,
    cptCode: inputRow.cptCode,
    claimNumber: "",
    memberName: "",
    providerName: "",
    providerClaimId: inputRow.providerClaimId,
    dateOfService: "",
    claimStatus: "",
    company: "",
    dateReceived: "",
    datePaid: "",
    checkNumber: "",
    paymentStatus: "",
    vendor: "",
    payee: "",
    claimType: "",
    serviceLines: "",
    finalStatus: botMessage,
  };
}

function outputRowFromClaim(
  inputRow: MyFamilyInputRow,
  result: SearchResultRow,
  details: DetailFieldMap,
  serviceLines: string,
  resolvedName: ResolvedName,
): MyFamilyOutputRow {
  const finalStatus = cleanText(
    `DOS ${inputRow.dos}: My family claim ${result.claimNumber} ${details.Status || result.status || "found"}` +
      `${details.Check ? ` check ${details.Check}` : ""}${details["Date Paid"] ? ` paid ${details["Date Paid"]}` : ""}.`,
  );
  return {
    ...baseOutputRow(inputRow, "Success", "Claim found.", resolvedName),
    claimNumber: result.claimNumber,
    memberName: result.memberName,
    providerName: result.providerName,
    providerClaimId: result.providerClaimId,
    dateOfService: result.dateOfService,
    claimStatus: details.Status || result.status,
    company: result.company || details["Company ID"] || "",
    dateReceived: details["Date Received"] || "",
    datePaid: details["Date Paid"] || "",
    checkNumber: details.Check || "",
    paymentStatus: details["Payment Status"] || "",
    vendor: details.Vendor || "",
    payee: details.Payee || "",
    claimType: details["Claim Type"] || "",
    serviceLines,
    finalStatus,
  };
}

function addAudit(state: MyFamilyWorkbookState, inputRow: MyFamilyInputRow | null, step: string, status: string, message: string): void {
  state.auditRows.push({
    timestamp: nowIso(),
    inputRowId: inputRow?.inputRowId ?? "",
    memberId: inputRow?.memberId ?? "",
    step,
    status,
    message,
  } satisfies MyFamilyAuditRow);
}

async function findVisibleLocator(page: Page, selector: string, timeout = 2500): Promise<Locator | null> {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: "visible", timeout });
    return locator;
  } catch {
    return null;
  }
}

async function clickIfVisible(page: Page, selector: string, timeout = 2500): Promise<boolean> {
  const locator = await findVisibleLocator(page, selector, timeout);
  if (!locator) return false;
  await locator.click({ timeout: 5000 }).catch(async () => locator.evaluate((element) => (element as HTMLElement).click()));
  await page.waitForTimeout(500);
  return true;
}

/** Simple fill used only for the login form, which does not have masked/scripted inputs. */
async function fillField(page: Page, selector: string, value: string): Promise<void> {
  const locator = await findVisibleLocator(page, selector, 5000);
  if (!locator) throw new Error(`Could not find My family field: ${selector}`);
  await locator.click();
  await locator.fill("");
  if (value) await locator.fill(value);
}

/**
 * Fill + verify for Claim Search fields. Member ID / Patient First/Last Name have
 * onkeydown handlers on the live portal, so a plain .fill() can silently leave the field
 * empty or partially filled. We fill, read the value back, and if it doesn't match we
 * retry by typing character-by-character, which reliably fires those handlers.
 */
async function fillFieldVerified(page: Page, selector: string, value: string, label: string): Promise<void> {
  const locator = await findVisibleLocator(page, selector, 8000);
  if (!locator) throw new Error(`Could not find My family field: ${label} (${selector})`);

  await locator.click({ timeout: 5000 });
  await locator.fill("");
  await page.waitForTimeout(120);

  if (!value) return;

  await locator.fill(value);
  await page.waitForTimeout(150);
  let current = await locator.inputValue().catch(() => "");

  if (cleanText(current).toUpperCase() !== cleanText(value).toUpperCase()) {
    await locator.fill("");
    await page.waitForTimeout(100);
    await locator.pressSequentially(value, { delay: 60 });
    await page.waitForTimeout(150);
    current = await locator.inputValue().catch(() => "");
  }

  if (cleanText(current).toUpperCase() !== cleanText(value).toUpperCase()) {
    throw new Error(`My family field "${label}" did not accept value "${value}" (currently shows "${current}").`);
  }
}

function toMonthDayYear(value: string): { month: string; day: string; year: string } | null {
  const trimmed = value.trim();
  let match = trimmed.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (match) {
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    return { month: match[1], day: match[2], year };
  }
  match = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) {
    return { month: match[2], day: match[3], year: match[1] };
  }
  return null;
}

/**
 * The Service Date From/To boxes are Infragistics masked date pickers, not plain text
 * inputs. A plain .fill() with a "MM/DD/YYYY" string frequently gets rejected or only
 * partially applied, which is why dates weren't being applied correctly. We type the
 * date as real keystrokes (input.ts's normalizeDate already produces the "M/D/YYYY"
 * format the widget displays, e.g. "3/31/2026"), verify the resulting value, and fall
 * back to a digits-only entry (which masked date pickers also accept) if needed.
 */
async function setServiceDate(page: Page, selector: string, rawValue: string, label: string): Promise<void> {
  const parts = toMonthDayYear(rawValue);
  if (!parts) throw new Error(`Unrecognized date format for ${label}: "${rawValue}"`);

  const locator = await findVisibleLocator(page, selector, 8000);
  if (!locator) throw new Error(`Could not find My family field: ${label} (${selector})`);

  const formatted = `${Number(parts.month)}/${Number(parts.day)}/${parts.year}`;
  const digitsOnly = `${parts.month.padStart(2, "0")}${parts.day.padStart(2, "0")}${parts.year}`;

  const enter = async (text: string): Promise<void> => {
    await locator.click({ timeout: 5000 });
    await page.keyboard.press("Control+A").catch(() => {});
    await page.keyboard.press("Delete").catch(() => {});
    await page.waitForTimeout(100);
    await locator.pressSequentially(text, { delay: 60 });
    await page.keyboard.press("Tab").catch(() => {});
    await page.waitForTimeout(250);
  };

  await enter(formatted);
  let current = cleanText(await locator.inputValue().catch(() => ""));

  if (normalizeComparableDate(current) !== normalizeComparableDate(formatted)) {
    await enter(digitsOnly);
    current = cleanText(await locator.inputValue().catch(() => ""));
  }

  if (normalizeComparableDate(current) !== normalizeComparableDate(formatted)) {
    throw new Error(`My family field "${label}" shows "${current}" after entering "${formatted}".`);
  }
}

async function visibleBodyText(page: Page): Promise<string> {
  return page.locator("body").innerText({ timeout: 1500 }).catch(() => "");
}

async function openLoginForm(page: Page, context: ScraperContext): Promise<void> {
  if (await findVisibleLocator(page, myFamilyConfig.selectors.username, 800)) return;

  await context.log({ level: "info", message: "Opening My family login panel from header Login control." });
  const clicked = await clickIfVisible(page, myFamilyConfig.selectors.loginLink, 8000);
  if (!clicked) {
    const opened = await page.evaluate(() => {
      const showLogin = (window as typeof window & { showLogin?: () => void }).showLogin;
      if (typeof showLogin === "function") {
        showLogin();
        return true;
      }
      const loginLink = document.querySelector<HTMLElement>("#tblLogin a[onclick*='showLogin'], #tblLogin a");
      if (!loginLink) return false;
      loginLink.click();
      return true;
    }).catch(() => false);
    if (!opened) throw new Error("Could not find My family header Login control.");
  }

  const usernameField = await findVisibleLocator(page, myFamilyConfig.selectors.username, 10000);
  if (!usernameField) throw new Error("My family login panel did not open after clicking Login.");
}

async function captureDiagnostics(context: ScraperContext, page: Page, inputRow: MyFamilyInputRow | null, reason: string): Promise<void> {
  const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "error";
  const dir = path.join(process.cwd(), ".tmp", "my-family", context.jobId);
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  const rowLabel = inputRow ? `row-${inputRow.inputRowId}` : "job";
  const screenshotPath = path.join(dir, `${rowLabel}-${safeReason}.jpg`);
  const htmlPath = path.join(dir, `${rowLabel}-${safeReason}.html`);

  const screenshot = await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(htmlPath, html, "utf8").catch(() => {});
    await context.emit({ type: "debug_html", index: inputRow?.inputRowId, html, path: htmlPath, filename: `my_family_${rowLabel}_${safeReason}.html` });
  }
  if (screenshot) {
    await context.emit({ type: "error_screenshot", index: inputRow?.inputRowId, image: screenshot.toString("base64"), path: screenshotPath });
  }
}

async function login(page: Page, input: Awaited<ReturnType<typeof parseMyFamilyInput>>, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Opening My family EZ-NET login page." });
  await page.goto(input.credentials.loginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await openLoginForm(page, context);
  await fillField(page, myFamilyConfig.selectors.username, input.credentials.username);
  await fillField(page, myFamilyConfig.selectors.password, input.credentials.password);
  await context.log({ level: "info", message: "Submitting My family credentials." });
  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    clickIfVisible(page, myFamilyConfig.selectors.submit, 5000),
  ]);
  await page.waitForTimeout(myFamilyConfig.timing.postLoginMs);
  if (await findVisibleLocator(page, myFamilyConfig.selectors.password, 1000)) {
    throw new Error("My family login failed or did not leave the login form.");
  }
  await context.log({ level: "info", message: "My family login completed." });
}

async function openClaimSearch(page: Page, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Opening My family Claim Search page." });
  await clickIfVisible(page, myFamilyConfig.selectors.mainMenu, 2500);
  await page.waitForTimeout(myFamilyConfig.timing.postNavigationMs);
  await page.goto(myFamilyConfig.claimSearchUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(async () => {
    await clickIfVisible(page, myFamilyConfig.selectors.claimsMenu, 2500);
    await clickIfVisible(page, myFamilyConfig.selectors.claimSearchLink, 2500);
  });
  await findVisibleLocator(page, myFamilyConfig.selectors.memberId, 10000);
  await context.log({ level: "info", message: "My family Claim Search page is ready." });
}

/** Clears the search form and waits for the Clear postback to actually finish. */
async function clearSearch(page: Page): Promise<void> {
  const cleared = await clickIfVisible(page, myFamilyConfig.selectors.clearButton, 1500);
  if (cleared) {
    const memberIdLocator = await findVisibleLocator(page, myFamilyConfig.selectors.memberId, 4000);
    if (memberIdLocator) {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const value = await memberIdLocator.inputValue().catch(() => "");
        if (!value) break;
        await page.waitForTimeout(200);
      }
    }
    return;
  }
  await page.goto(myFamilyConfig.claimSearchUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await findVisibleLocator(page, myFamilyConfig.selectors.memberId, 10000);
}

async function extractSearchRows(page: Page): Promise<SearchResultRow[]> {
  return page.evaluate((gridSelector) => {
    function clean(value: string | null | undefined): string {
      return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
    const rows = Array.from(document.querySelectorAll(`${gridSelector} tbody[mkr='rows'] tr[role='row']`));
    return rows
      .map((row) => {
        const cells = Array.from(row.querySelectorAll("td")).map((cell) => clean(cell.textContent));
        const claimLink = row.querySelector<HTMLAnchorElement>("a[href*='ClaimDetails.aspx']");
        return {
          claimNumber: clean(claimLink?.textContent || cells[0]),
          memberName: cells[1] || "",
          providerName: cells[2] || "",
          providerClaimId: cells[3] || "",
          dateOfService: cells[4] || "",
          status: cells[5] || "",
          company: cells[6] || "",
          rowText: clean(row.textContent),
        };
      })
      .filter((row) => row.claimNumber);
  }, myFamilyConfig.selectors.resultGrid);
}

/**
 * Claim Search runs its search via an ASP.NET UpdatePanel (async) postback, not a full
 * page navigation. Waiting on "domcontentloaded" after clicking Search (the old
 * behaviour) never actually fires, so the code was falling straight through to a fixed
 * delay and grabbing the grid before it updated. Instead we poll the grid itself until
 * either result rows appear or the "No Records Found" message becomes visible.
 */
async function waitForSearchResults(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await page
      .evaluate(
        ({ noDataSelector, rowsSelector }) => {
          const noData = document.querySelector(noDataSelector) as HTMLElement | null;
          const rows = document.querySelectorAll(rowsSelector).length;
          const noDataVisible = !!noData && noData.offsetParent !== null && (noData.textContent || "").trim().length > 0;
          return { rows, noDataVisible };
        },
        { noDataSelector: myFamilyConfig.selectors.noData, rowsSelector: myFamilyConfig.selectors.resultRows },
      )
      .catch(() => ({ rows: 0, noDataVisible: false }));
    if (state.rows > 0 || state.noDataVisible) return;
    await page.waitForTimeout(400);
  }
}

async function submitSearch(
  page: Page,
  inputRow: MyFamilyInputRow,
  context: ScraperContext,
  resolvedName: ResolvedName,
): Promise<SearchResultRow[]> {
  await clearSearch(page);

  if (inputRow.memberId) {
    await fillFieldVerified(page, myFamilyConfig.selectors.memberId, inputRow.memberId, "Member ID");
  } else {
    await fillFieldVerified(page, myFamilyConfig.selectors.patientFirstName, resolvedName.firstName, "Patient First Name");
    await fillFieldVerified(page, myFamilyConfig.selectors.patientLastName, resolvedName.lastName, "Patient Last Name");
  }

  if (inputRow.dos) {
    await setServiceDate(page, myFamilyConfig.selectors.serviceDateFrom, inputRow.dos, "Service Date From");
    await setServiceDate(page, myFamilyConfig.selectors.serviceDateTo, inputRow.dos, "Service Date To");
  }

  await context.log({
    level: "info",
    message: `Searching My family row ${inputRow.inputRowId}: ${
      inputRow.memberId ? `Member ID ${maskValue(inputRow.memberId)}` : `${resolvedName.lastName}, ${resolvedName.firstName}`
    }, DOS ${inputRow.dos}.`,
    rowIndex: inputRow.inputRowId,
  });

  const clicked = await clickIfVisible(page, myFamilyConfig.selectors.searchButton, 5000);
  if (!clicked) throw new Error("Could not click the My family Search button.");

  await waitForSearchResults(page, Math.max(myFamilyConfig.timing.postSearchMs, 15000));
  await page.waitForTimeout(300);
  return extractSearchRows(page);
}

function rowMatchesInput(row: SearchResultRow, inputRow: MyFamilyInputRow, resolvedName: ResolvedName): boolean {
  const dosMatches = !inputRow.dos || normalizeComparableDate(row.dateOfService) === normalizeComparableDate(inputRow.dos);
  const providerClaimMatches =
    !inputRow.providerClaimId || cleanText(row.providerClaimId).toUpperCase() === cleanText(inputRow.providerClaimId).toUpperCase();

  let nameMatches = true;
  if (!inputRow.memberId) {
    const rowName = normalizeName(row.memberName);
    const { firstName, lastName } = resolvedName;
    nameMatches =
      (!lastName || rowName.includes(normalizeName(lastName))) && (!firstName || rowName.includes(normalizeName(firstName)));
  }

  return dosMatches && providerClaimMatches && nameMatches;
}

async function openClaimDetail(page: Page, result: SearchResultRow): Promise<void> {
  const claimNumber = result.claimNumber.trim();
  const claimLink = page
    .locator(`${myFamilyConfig.selectors.resultGrid} ${CLAIM_LINK_SELECTOR}`)
    .filter({ hasText: claimNumber })
    .first();

  if ((await claimLink.count()) === 0) {
    throw new Error(`Could not find a clickable link for claim number "${claimNumber}" in the search results grid.`);
  }

  await Promise.all([
    page.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}),
    claimLink.click({ timeout: 10000 }),
  ]);
  await findVisibleLocator(page, myFamilyConfig.selectors.detailsMarker, 15000).catch(() => null);
  await page.waitForTimeout(myFamilyConfig.timing.detailLoadMs);
}

async function extractDetailFields(page: Page): Promise<DetailFieldMap> {
  return page.evaluate(() => {
    function clean(value: string | null | undefined): string {
      return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim().replace(/:$/, "");
    }
    const labels = [
      "Claim#", "Company ID", "Auth/Referral#", "Status", "Date Received", "Provider Claim #",
      "Date Paid", "Check", "Payment Status", "EFT Trace #", "Vendor", "Reference #", "Payee",
      "Claim Type", "Cross Reference ID",
    ];
    const result: Record<string, string> = {};
    const elements = Array.from(document.querySelectorAll("td, div, span, label"));
    for (const element of elements) {
      const text = clean(element.textContent);
      for (const label of labels) {
        if (text === label || text === label.replace(/#$/, "")) {
          const parent = element.parentElement;
          const siblings = parent ? Array.from(parent.children) : [];
          const index = siblings.indexOf(element);
          const next = index >= 0 ? siblings.slice(index + 1).map((child) => clean(child.textContent)).find(Boolean) : "";
          if (next && !result[label.replace(/#$/, "")]) result[label.replace(/#$/, "")] = next;
        } else if (text.startsWith(`${label}:`)) {
          const value = clean(text.slice(label.length + 1));
          if (value) result[label.replace(/#$/, "")] = value;
        }
      }
    }
    return result;
  });
}

/**
 * Extracts rows from the Services grid as column-keyed records, then keeps only the
 * rows whose "Service Code" (CPT) exactly matches the input row's CPT code. If a CPT is
 * given and none of the service lines match it, nothing is extracted for that claim, per
 * the required behaviour ("only when the CPT in the excel matches the Service Code... if
 * it doesn't match we are not extracting it").
 */
async function extractServiceLines(page: Page, inputRow: MyFamilyInputRow): Promise<string> {
  const records = await page.evaluate((gridSelector: string) => {
    function clean(value: string | null | undefined): string {
      return String(value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    }
    const headers = Array.from(document.querySelectorAll(`${gridSelector} th.igg_HeaderCaption`)).map((header) =>
      clean(header.textContent),
    );
    const bodyRows = Array.from(document.querySelectorAll(`${gridSelector} tbody[mkr='rows'] tr[role='row']`));
    return bodyRows.map((row) => {
      const cells = Array.from(row.querySelectorAll("td")).map((cell) => clean(cell.textContent));
      const record: Record<string, string> = {};
      cells.forEach((cell, index) => {
        record[headers[index] || `Column ${index + 1}`] = cell;
      });
      return record;
    });
  }, myFamilyConfig.selectors.servicesGrid);

  if (!records.length) return "";

  const desiredColumns = [
    "Service Date", "Service Code", "Description", "CPT Mod", "Qty", "Billed Amt", "Cntc Amt",
    "Deductible", "Deductible Dtls", "Deductible Adv Rule", "Copay", "Coinsurance", "WH Amt",
    "Adj Amt", "Net Paid", "Adj Grp Code", "Adj Code", "Adj Desc", "Remitt_Code", "Remitt_Desc",
    "Place Of Service", "Control Number", "Mammography Cert #", "Rend Prov ID", "Rend Prov NPI",
    "Taxonomy Code", "Payment Status",
  ];

  const cpt = inputRow.cptCode ? normalizeCptCode(inputRow.cptCode) : "";
  const matched = cpt ? records.filter((record) => normalizeCptCode(record["Service Code"] || "") === cpt) : records;

  if (cpt && !matched.length) return "";

  return matched.map((record) => desiredColumns.map((column) => `${column}: ${record[column] ?? ""}`).join(" | ")).join("\n");
}

/**
 * Returns to a clean Claim Search page for the next row. Rather than relying on
 * page.goBack() (unreliable for this UpdatePanel-driven page), we re-navigate to the
 * Claim Search URL directly, matching the documented fallback flow (Claims > Search),
 * then clear the form so stale values from the previous row can't leak into the next.
 */
async function goBackToSearch(page: Page, context: ScraperContext): Promise<void> {
  await context.log({ level: "info", message: "Returning to My family Claim Search page for the next row." }).catch(() => {});
  await page.goto(myFamilyConfig.claimSearchUrl, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(async () => {
    await clickIfVisible(page, myFamilyConfig.selectors.mainMenu, 2000);
    await clickIfVisible(page, myFamilyConfig.selectors.claimsMenu, 2000);
    await clickIfVisible(page, myFamilyConfig.selectors.claimSearchLink, 2000);
  });
  await findVisibleLocator(page, myFamilyConfig.selectors.memberId, 10000);
  await clearSearch(page);
}

async function processRow(page: Page, inputRow: MyFamilyInputRow, state: MyFamilyWorkbookState, context: ScraperContext): Promise<void> {
  const resolvedName = resolvePatientName(inputRow);
  const hasIdentifier = Boolean(cleanText(inputRow.memberId || "")) || Boolean(resolvedName.firstName && resolvedName.lastName);
  const hasDos = Boolean(cleanText(inputRow.dos || ""));

  if (!hasIdentifier) {
    const status = "Missing Member ID or Patient First/Last Name";
    state.outputRows.push(baseOutputRow(inputRow, status, status, resolvedName));
    addAudit(state, inputRow, "validation", "failed", status);
    return;
  }

  if (!hasDos) {
    const status = "Missing DOS";
    state.outputRows.push(baseOutputRow(inputRow, status, status, resolvedName));
    addAudit(state, inputRow, "validation", "failed", status);
    return;
  }

  // Any remaining validation failure at this point (e.g. an unparsable DOS) is a real
  // problem, not a name/member-id issue we've already resolved above.
  if (inputRow.validationStatus !== "valid" && !/member\s*id|patient.*name/i.test(inputRow.validationMessage || "")) {
    state.outputRows.push(baseOutputRow(inputRow, inputRow.validationMessage || "Invalid row", inputRow.validationMessage, resolvedName));
    addAudit(state, inputRow, "validation", "failed", inputRow.validationMessage);
    return;
  }

  addAudit(state, inputRow, "search", "started", "Submitting My family claim search.");
  const searchRows = await submitSearch(page, inputRow, context, resolvedName);
  if (!searchRows.length) {
    const pageText = await visibleBodyText(page);
    const status = /member not found|invalid member/i.test(pageText) ? "Member Not Found" : "No Claims Found";
    state.outputRows.push(baseOutputRow(inputRow, status, status, resolvedName));
    addAudit(state, inputRow, "search", "completed", status);
    return;
  }

  const matchingRows = searchRows.filter((row) => rowMatchesInput(row, inputRow, resolvedName));
  const selectedRows = matchingRows.length ? matchingRows : searchRows;
  await context.log({
    level: "info",
    message: `My family row ${inputRow.inputRowId}: found ${searchRows.length} result(s) (${matchingRows.length} matched patient/DOS), processing claim ${selectedRows[0].claimNumber}.`,
    rowIndex: inputRow.inputRowId,
  });
  const result = selectedRows[0];
  await openClaimDetail(page, result);
  const details = await extractDetailFields(page);
  const serviceLines = await extractServiceLines(page, inputRow);
  state.outputRows.push(outputRowFromClaim(inputRow, result, details, serviceLines, resolvedName));
  addAudit(state, inputRow, "detail", "completed", `Extracted claim ${result.claimNumber}.`);
  await goBackToSearch(page, context);
}

async function emitArtifacts(context: ScraperContext, state: MyFamilyWorkbookState): Promise<void> {
  const workbookBuffer = await createMyFamilyOutputWorkbookBuffer(state);
  await context.emit({
    type: "file_download",
    filename: "my_family_output.xlsx",
    base64: workbookBuffer.toString("base64"),
    mimeType: OUTPUT_MIME,
  });
  const logContent = state.auditRows.map((row) => `[${row.timestamp}] row=${row.inputRowId} ${row.step} ${row.status}: ${row.message}`).join("\n");
  await context.emit({
    type: "file_download",
    filename: "my-family-run.log",
    base64: Buffer.from(logContent, "utf8").toString("base64"),
    mimeType: "text/plain",
  });
}

export async function runMyFamilyClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parseMyFamilyInput(formData);
  const rows = readMyFamilyInputWorkbook(input.inputWorkbookBuffer);
  const state: MyFamilyWorkbookState = { outputRows: [], auditRows: [] };
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    await context.log({ level: "info", message: `My family input loaded: ${rows.length} row(s).` });
    await context.emit({ type: "progress", completed: 0, total: rows.length });
    browser = await launchMyFamilyBrowser((message) => context.log({ level: "info", message }));
    page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await login(page, input, context);
    await openClaimSearch(page, context);

    let completed = 0;
    for (const row of rows) {
      if (context.isCancelled?.()) {
        await context.log({ level: "warn", message: "My family run stopped by user. Creating partial output." });
        await context.emit({ type: "cancelled", message: "My family scraping stopped. Partial workbook downloaded." });
        break;
      }
      try {
        await processRow(page, row, state, context);
      } catch (error) {
        const message = errorMessage(error);
        state.outputRows.push(baseOutputRow(row, "Portal Error", message));
        addAudit(state, row, "row_processing", "failed", message);
        if (page) await captureDiagnostics(context, page, row, "row-error");
        await openClaimSearch(page, context).catch(() => {});
      }
      completed += 1;
      await context.emit({ type: "progress", completed, total: rows.length });
      await page.waitForTimeout(myFamilyConfig.timing.betweenRowsMs);
    }

    await emitArtifacts(context, state);
    await context.emit({ type: "done" });
  } catch (error) {
    const message = errorMessage(error);
    addAudit(state, null, "job", "failed", message);
    await context.log({ level: "error", message: `My family run failed: ${message}` });
    if (page) await captureDiagnostics(context, page, null, "job-error");
    await emitArtifacts(context, state).catch(() => {});
    await context.emit({ type: "error", message });
    await context.emit({ type: "done" });
  } finally {
    await closeAutomationResources({
      browser,
      page,
      log: (message: string) => context.log({ level: "info", message }),
    });
  }
}
