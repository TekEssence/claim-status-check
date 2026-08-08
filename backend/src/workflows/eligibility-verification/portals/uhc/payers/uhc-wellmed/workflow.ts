import ExcelJS from "exceljs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright-core";
import type { AutomationContext } from "../../../../../types";
import { applyUhcResultLayout } from "./result-parser";

export const UHC_OUTPUT_HEADERS = [
  "Coverage Status",
  "Eff Date",
  "End Date",
  "Other Ins",
  "Other Ins Eff Date",
  "Relationship to Subscriber",
  "Plan Type",
  "Bot Insurance Type",
  "Network",
  "Coinsurance",
  "Copay",
  "Deductible",
  "Deductible Met",
  "Out of Pocket",
  "Out of Pocket Met",
  "Error",
] as const;

export type UhcEligibilityOutput = Record<(typeof UHC_OUTPUT_HEADERS)[number], string>;

type UhcInputRow = {
  worksheetRow: number;
  memberId: string;
  dateOfBirth: string;
};

const UHC_SAVE_INTERVAL = 5;

const SELECTORS = {
  eligibilityLink: "div[data-testid='eligibility-link']",
  memberId: "#eligibility-memberid-input, input[name='search.memberId'], input[data-testid='eligibility-search-member-id-abyss-text-input']",
  dateOfBirth: "#eligibility-dateofbirth-input, input[name='search.dateOfBirth'], input[name='search.dob'], input[data-testid='eligibility-search-DOB-abyss-date-picker-input']",
  submit: "button#submit-search-button, button:has-text('Verify Eligibility')",
  newSearch: "button[data-testid='overview-new-search-button-abyss-button-root'], button:has-text('New Search')",
} as const;

async function openEligibilitySearch(page: Page): Promise<void> {
  const eligibility = page.locator(SELECTORS.eligibilityLink).filter({ hasText: /^\s*Eligibility\s*$/ });
  const link = await firstVisibleLocator(page, eligibility, 60_000, "Eligibility navigation link");
  await link.scrollIntoViewIfNeeded().catch(() => {});
  await link.click();

  await firstVisibleLocator(page, SELECTORS.memberId, 60_000, "Member ID field");
  await firstVisibleLocator(page, SELECTORS.dateOfBirth, 60_000, "date of birth field");
}

const LABELS: Record<keyof UhcEligibilityOutput, string[]> = {
  "Coverage Status": ["Coverage Status", "Member Status", "Coverage"],
  "Eff Date": ["Eff Date", "Effective Date", "Coverage Effective Date", "Plan Effective Date"],
  "End Date": ["End Date", "Termination Date", "Coverage End Date", "Plan End Date"],
  "Other Ins": ["Other Ins", "Other Insurance", "Additional Payer", "Additional Insurance"],
  "Other Ins Eff Date": ["Other Ins Eff Date", "Other Insurance Effective Date", "Additional Payer Effective Date"],
  "Relationship to Subscriber": ["Relationship to Subscriber", "Relationship"],
  "Plan Type": ["Plan Type", "Product Type"],
  "Bot Insurance Type": ["Insurance Type", "Coverage Type"],
  "Network": ["Network", "Network Status", "In/Out Network"],
  "Coinsurance": ["Coinsurance", "Co-insurance"],
  "Copay": ["Copay", "Co-pay"],
  "Deductible": ["Deductible"],
  "Deductible Met": ["Deductible Met", "Amount Met - Deductible", "Deductible Amount Met"],
  "Out of Pocket": ["Out of Pocket", "Out-of-Pocket", "OOP Maximum"],
  "Out of Pocket Met": ["Out of Pocket Met", "Out-of-Pocket Met", "OOP Met"],
  "Error": ["Error"],
};

function normalizeLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function outputTemplate(): UhcEligibilityOutput {
  return Object.fromEntries(UHC_OUTPUT_HEADERS.map((header) => [header, ""])) as UhcEligibilityOutput;
}

function labeledValue(text: string, aliases: string[]): string {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const normalizedAliases = aliases.map(normalizeLabel);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const normalizedLine = normalizeLabel(line);
    for (const alias of normalizedAliases) {
      if (normalizedLine === alias) return lines[index + 1] ?? "";
      if (normalizedLine.startsWith(`${alias} `) && /[:-]/.test(line)) {
        return line.replace(/^[^:-]+[:-]\s*/, "").trim();
      }
    }
  }
  return "";
}

export function parseUhcEligibilityResultText(text: string): UhcEligibilityOutput {
  const output = outputTemplate();
  for (const header of UHC_OUTPUT_HEADERS) output[header] = labeledValue(text, LABELS[header]);

  const status = text.match(/\b(?:coverage|member)\s+status\s*[:-]?\s*(active|inactive)\b/i)?.[1];
  if (status) output["Coverage Status"] = status[0].toUpperCase() + status.slice(1).toLowerCase();
  return applyUhcResultLayout(text, output);
}

function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (value instanceof Date) {
    return `${String(value.getMonth() + 1).padStart(2, "0")}/${String(value.getDate()).padStart(2, "0")}/${value.getFullYear()}`;
  }
  if (typeof value === "object" && "text" in value) return String(value.text ?? "").trim();
  return String(value).trim();
}

function normalizedHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findColumn(headers: Map<string, number>, aliases: string[]): number {
  for (const alias of aliases) {
    const column = headers.get(normalizedHeader(alias));
    if (column) return column;
  }
  return 0;
}

function readInputRows(sheet: ExcelJS.Worksheet): UhcInputRow[] {
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
    headers.set(normalizedHeader(cellText(cell.value)), column);
  });
  const memberColumn = findColumn(headers, [
    "Member ID",
    "Member Id",
    "Member is",
    "Member Number",
    "Member No",
    "Subscriber ID",
    "Subscriber Id",
    "Subscriber No",
    "Subscriber Number",
    "Primary Ins Subscriber ID",
    "Primary Ins Subscriber No",
    "Primary Insurance Subscriber ID",
    "Primary Insurance Subscriber No",
    "Patient ID",
    "Patient Id",
    "ID",
    "Id",
  ]);
  const dobColumn = findColumn(headers, [
    "DOB",
    "Date of Birth",
    "Birth Date",
    "Birthdate",
    "Patient DOB",
    "Patient Date of Birth",
    "Patient Birth Date",
    "Patient Birthdate",
    "Member DOB",
    "Member Date of Birth",
    "Subscriber DOB",
    "Subscriber Date of Birth",
  ]);
  if (!memberColumn || !dobColumn) throw new Error("UHC eligibility workbook requires Member ID and Date of Birth/DOB columns.");

  const rows: UhcInputRow[] = [];
  for (let worksheetRow = 2; worksheetRow <= sheet.rowCount; worksheetRow += 1) {
    const row = sheet.getRow(worksheetRow);
    const memberId = cellText(row.getCell(memberColumn).value);
    const dateOfBirth = cellText(row.getCell(dobColumn).value);
    if (!memberId && !dateOfBirth) continue;
    rows.push({ worksheetRow, memberId, dateOfBirth });
  }
  if (!rows.length) throw new Error("The UHC eligibility workbook does not contain member rows.");
  return rows;
}

function formatDob(value: string): string {
  const match = value.trim().match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  return match ? `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${match[3]}` : value.trim();
}

async function enterSearch(page: Page, row: UhcInputRow): Promise<void> {
  const member = await firstVisibleLocator(page, SELECTORS.memberId, 60_000, "Member ID field");
  const dob = await firstVisibleLocator(page, SELECTORS.dateOfBirth, 60_000, "date of birth field");
  await typeSearchValue(page, member, row.memberId, 120);
  await typeSearchValue(page, dob, formatDob(row.dateOfBirth), 140);
  await dob.press("Tab");
  await page.waitForTimeout(800);
  const submit = await firstVisibleLocator(page, SELECTORS.submit, 30_000, "eligibility search button");
  await submit.click();
  await page.waitForTimeout(1_000);
}

async function firstVisibleLocator(
  page: Page,
  selector: string | Locator,
  timeout: number,
  label: string,
): Promise<Locator> {
  const deadline = Date.now() + timeout;
  const candidates = typeof selector === "string" ? page.locator(selector) : selector;
  while (Date.now() < deadline) {
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`A visible UHC ${label} was not found.`);
}
async function typeSearchValue(page: Page, field: Locator, value: string, delay: number): Promise<void> {
  await field.waitFor({ state: "attached" });
  await field.scrollIntoViewIfNeeded().catch(() => {});
  await field.evaluate((element) => (element as HTMLInputElement).focus());
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+A");
  await page.waitForTimeout(250);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(300);
  await page.keyboard.type(value, { delay });
  await page.waitForTimeout(700);
  if (await field.inputValue() !== value) {
    throw new Error("A UHC eligibility search field did not retain its exact input value.");
  }
}

async function ancestorTextContaining(
  locator: Locator,
  required: RegExp[],
  maxDepth = 8,
): Promise<string> {
  if (await locator.count().catch(() => 0) === 0) return "";
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.page().waitForTimeout(500);

  let current = locator;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const text = await current.innerText({ timeout: 1_000 }).catch(() => "");
    if (required.every((pattern) => pattern.test(text))) return text;
    current = current.locator("xpath=..");
  }
  return "";
}

async function optionalVisibleText(page: Page, locator: Locator): Promise<string> {
  if (await locator.count().catch(() => 0) === 0) return "";
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  return locator.innerText({ timeout: 2_000 }).catch(() => "");
}

async function textAroundAnyLabel(
  page: Page,
  candidates: Locator,
  required: RegExp[],
  maxDepth = 7,
): Promise<string> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      await candidate.scrollIntoViewIfNeeded().catch(() => {});
      await page.waitForTimeout(800);
      const text = await ancestorTextContaining(candidate, required, maxDepth);
      if (text) return text;
    }
    await page.waitForTimeout(300);
  }
  return "";
}
async function firstVisibleCandidate(page: Page, candidates: Locator, timeout = 10_000): Promise<Locator | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await candidates.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await page.waitForTimeout(250);
  }
  return null;
}
async function controlledSectionText(page: Page, trigger: Locator): Promise<string> {
  if (await trigger.count().catch(() => 0) === 0) return "";
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);

  const expanded = await trigger.getAttribute("aria-expanded", { timeout: 2_000 }).catch(() => null);
  if (expanded !== "true") {
    await trigger.click();
    await page.waitForTimeout(1_800);
  }

  const parts: string[] = [];
  const controls = await trigger.getAttribute("aria-controls", { timeout: 2_000 }).catch(() => null);
  if (controls) {
    const controlled = page.locator('[id="' + controls + '"]').first();
    await controlled.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(800);
    const text = await controlled.innerText({ timeout: 3_000 }).catch(() => "");
    if (text) parts.push(text);
  }

  const network = await textAroundAnyLabel(
    page,
    page.getByText(/Network Status/i),
    [/Network Status/i, /In-Network|Out-of-Network|In Network|Out of Network/i],
  );
  if (network) parts.push(network);

  const planDeductibleElement = await firstVisibleCandidate(page, page.locator("#planDeductible"), 12_000);
  if (planDeductibleElement) {
    await planDeductibleElement.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(900);
    const text = await planDeductibleElement.innerText({ timeout: 3_000 }).catch(() => "");
    if (text) parts.push(text);
  }

  const outOfPocketElement = await firstVisibleCandidate(page, page.locator("#outOfPocketMax"), 12_000);
  if (outOfPocketElement) {
    await outOfPocketElement.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(900);
    const text = await outOfPocketElement.innerText({ timeout: 3_000 }).catch(() => "");
    if (text) parts.push(text);
  }

  const deductible = await textAroundAnyLabel(
    page,
    page.getByText(/Plan\s+Deductible\s+Per\s+Calendar\s+Year/i),
    [/Plan\s+Deductible\s+Per\s+Calendar\s+Year/i, /\$/i],
  );
  if (deductible) parts.push(deductible);

  const outOfPocket = await textAroundAnyLabel(
    page,
    page.getByText(/Out-of-Pocket\s+Maximum\s+Per\s+Calendar\s+Year/i),
    [/Out-of-Pocket\s+Maximum\s+Per\s+Calendar\s+Year/i, /\$/i],
  );
  if (outOfPocket) parts.push(outOfPocket);

  if (!parts.length) {
    const fallback = await ancestorTextContaining(trigger, [/Deductibles & Maximums/i, /Deductible|Out-of-Pocket/i]);
    if (fallback) parts.push(fallback);
  }
  return [...new Set(parts)].join(String.fromCharCode(10));
}
async function labeledRowText(page: Page, candidates: Locator, labels: RegExp): Promise<string> {
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    await candidate.scrollIntoViewIfNeeded().catch(() => {});
    let current = candidate;
    for (let depth = 0; depth <= 8; depth += 1) {
      const text = await current.innerText({ timeout: 1_500 }).catch(() => "");
      const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const labelIndex = lines.findIndex((line) => labels.test(line));
      if (labelIndex >= 0 && lines.slice(labelIndex + 1).some((line) => !labels.test(line))) return text;
      current = current.locator("xpath=..");
    }
  }
  return "";
}
async function readScopedUhcResultText(page: Page): Promise<string> {
  const policyLocator = page.locator("ul").filter({ hasText: /Policy Selected:/i }).first();
  const policy = await optionalVisibleText(page, policyLocator);

  const unitedHealthcareHeading = page.locator("h3").filter({ hasText: /^UNITEDHEALTHCARE$/i }).first();
  const planName = await labeledRowText(
    page,
    page.getByText(/^(?:Plan Name|Insurance Type|Coverage Type)$/i),
    /^(?:Plan Name|Insurance Type|Coverage Type)$/i,
  );
  const planType = await labeledRowText(
    page,
    page.getByText(/^(?:Plan Type|Product Type)$/i),
    /^(?:Plan Type|Product Type)$/i,
  );
  const planCard = await ancestorTextContaining(
    unitedHealthcareHeading,
    [/Plan Type|Product Type/i, /Plan Name|Insurance Type|Coverage Type/i],
    15,
  );
  const plan = [planName, planType, planCard].filter(Boolean).join(String.fromCharCode(10));

  const coordinationLocator = page.locator("[data-testid='vendor-coverage-abyss-grid-col']").first();
  const coordination = await optionalVisibleText(page, coordinationLocator);

  const deductibleCandidates = page.locator("button").filter({ hasText: /Deductibles & Maximums/i });
  const deductibleTrigger = await firstVisibleCandidate(page, deductibleCandidates, 15_000);
  const deductibles = deductibleTrigger ? await controlledSectionText(page, deductibleTrigger) : "";

  const popularHeading = page.getByText("POPULAR SERVICES COVERAGE", { exact: true }).first();
  if (await popularHeading.count().catch(() => 0)) {
    await popularHeading.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(600);
    const popularTrigger = popularHeading.locator("xpath=ancestor::button[1]");
    if (await popularTrigger.count().catch(() => 0)) {
      const expanded = await popularTrigger.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null);
      if (expanded !== "true") {
        await popularTrigger.click();
        await page.waitForTimeout(1_000);
      }
    }
  }
  const popular = await ancestorTextContaining(popularHeading, [/Specialist Visit/i, /Copay/i, /Coinsurance/i], 10);

  return [
    policy,
    "UNITEDHEALTHCARE",
    plan,
    "Coordination of Benefits",
    coordination,
    "Deductibles & Maximums",
    deductibles,
    "POPULAR SERVICES COVERAGE",
    popular,
  ].filter(Boolean).join(String.fromCharCode(10));
}

async function hasVisibleSearchForm(page: Page): Promise<boolean> {
  const candidates = page.locator(SELECTORS.memberId);
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function visibleNewSearchButton(page: Page, timeout = 60_000): Promise<Locator> {
  const deadline = Date.now() + timeout;
  const candidates = page.locator(SELECTORS.newSearch).filter({ hasText: /New Search/i });
  while (Date.now() < deadline) {
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("A visible UHC New Search button was not found after the eligibility response.");
}

async function openNewSearchForm(page: Page): Promise<void> {
  // A failed lookup can leave UHC on the search form already. In that state there
  // is no New Search button, so waiting for one prevents every later row running.
  if (await hasVisibleSearchForm(page)) return;

  const button = await visibleNewSearchButton(page);
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.waitFor({ state: "visible" });
  await button.click();
  const member = await firstVisibleLocator(page, SELECTORS.memberId, 60_000, "Member ID field");
  const dob = await firstVisibleLocator(page, SELECTORS.dateOfBirth, 60_000, "date of birth field");
  await member.waitFor({ state: "visible" });
  await dob.waitFor({ state: "visible" });
  // The form is rendered in a panel. Let its opening transition finish and
  // confirm it stayed open before the next row starts typing.
  await page.waitForTimeout(1_500);
  if (!await member.isVisible().catch(() => false) || !await dob.isVisible().catch(() => false)) {
    throw new Error("The UHC New Search form closed before Member ID and date of birth could be entered.");
  }
}
function cleanPortalMessage(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^(?:close|cancel)\s+/i, "").trim();
}

async function firstVisibleDialog(page: Page): Promise<Locator | null> {
  const dialogs = page.locator("[role='dialog'], [aria-modal='true']");
  const count = await dialogs.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const dialog = dialogs.nth(index);
    if (await dialog.isVisible().catch(() => false)) return dialog;
  }
  return null;
}

const UHC_SEARCH_ERROR_PATTERN = /your search returned|no (?:results|policies|coverage)|not found|unable to|could not|cannot|invalid|error|failed|problem|review your search criteria/i;
const UHC_NON_ERROR_PATTERN = /please wait while we retrieve|search for current member|designated behavioral health provider information/i;

function isUhcSearchErrorMessage(value: string): boolean {
  return value.length > 0
    && value.length < 1_000
    && UHC_SEARCH_ERROR_PATTERN.test(value)
    && !UHC_NON_ERROR_PATTERN.test(value);
}

async function visiblePortalError(page: Page): Promise<string> {
  const dialog = await firstVisibleDialog(page);
  if (dialog) {
    const text = cleanPortalMessage(await dialog.innerText({ timeout: 2_000 }).catch(() => ""));
    if (isUhcSearchErrorMessage(text)) return text;
  }

  const messages = page.getByText(
    /Your search returned|no results|no policies|no coverage|not found|review your search criteria|unable to complete|could not be completed|invalid|an error occurred|something went wrong/i,
  );
  const count = await messages.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const message = messages.nth(index);
    if (!await message.isVisible().catch(() => false)) continue;
    const text = cleanPortalMessage(await message.innerText({ timeout: 2_000 }).catch(() => ""));
    if (isUhcSearchErrorMessage(text)) return text;
  }
  return "";
}

async function dismissPortalError(page: Page): Promise<void> {
  const errorMessage = await visiblePortalError(page);
  if (!errorMessage) return;

  const dialog = await firstVisibleDialog(page);
  if (dialog) {
    const dialogText = cleanPortalMessage(await dialog.innerText({ timeout: 2_000 }).catch(() => ""));
    if (isUhcSearchErrorMessage(dialogText)) {
      const namedClose = dialog.getByRole("button", { name: /close|dismiss|cancel|ok/i }).first();
      if (await namedClose.isVisible().catch(() => false)) {
        await namedClose.click().catch(() => {});
      } else {
        const anyButton = dialog.locator("button").first();
        if (await anyButton.isVisible().catch(() => false)) await anyButton.click().catch(() => {});
      }
    }
  }

  if (await visiblePortalError(page)) {
    const message = page.getByText(
      /Your search returned|no results|no policies|no coverage|not found|review your search criteria|unable to complete|could not be completed|invalid|an error occurred|something went wrong/i,
    ).first();
    const popup = message.locator("xpath=ancestor::*[.//button][1]");
    const closeButton = popup.locator("button").first();
    if (await closeButton.isVisible().catch(() => false)) await closeButton.click().catch(() => {});
  }
  if (await visiblePortalError(page)) await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
}
class UhcCancellation extends Error {}

async function waitForFreshResult(
  page: Page,
  isCancelled?: () => boolean,
  timeout = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  const policyBanner = page.locator("ul").filter({ hasText: /Policy Selected:/i });
  let previous = "";
  let stableReads = 0;

  while (Date.now() < deadline) {
    if (isCancelled?.()) throw new UhcCancellation("UHC eligibility cancellation requested.");

    const portalError = await visiblePortalError(page);
    if (portalError) throw new Error(portalError);

    const formVisible = await hasVisibleSearchForm(page);
    let policyVisible = false;
    const policyCount = await policyBanner.count();
    for (let index = 0; index < policyCount; index += 1) {
      if (await policyBanner.nth(index).isVisible().catch(() => false)) {
        policyVisible = true;
        break;
      }
    }

    if (!formVisible && policyVisible) {
      const current = await page.locator("body").innerText();
      stableReads = current === previous ? stableReads + 1 : 0;
      previous = current;
      if (stableReads >= 2) return;
    } else {
      previous = "";
      stableReads = 0;
    }
    await page.waitForTimeout(750);
  }
  throw new Error("The UHC search form did not transition to a stable eligibility result page.");
}

function extractedFieldCount(result: Record<string, string>): number {
  return UHC_OUTPUT_HEADERS.filter((header) => Boolean(result[header]?.trim())).length;
}
function addOutputColumns(sheet: ExcelJS.Worksheet): number {
  const start = sheet.columnCount + 1;
  UHC_OUTPUT_HEADERS.forEach((header, offset) => {
    const cell = sheet.getRow(1).getCell(start + offset);
    cell.value = header;
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F4E78" } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    sheet.getColumn(start + offset).width = Math.max(14, Math.min(30, header.length + 2));
  });
  return start;
}

export function shouldRetryNoResult(message: string): boolean {
  return /^No Results Found$/i.test(message.trim())
    || /no results with the Member ID you submitted/i.test(message);
}

async function searchAndExtractUhcRow(
  page: Page,
  row: UhcInputRow,
  openNewSearch: boolean,
  isCancelled?: () => boolean,
): Promise<UhcEligibilityOutput> {
  if (openNewSearch) await openNewSearchForm(page);
  await enterSearch(page, row);
  await waitForFreshResult(page, isCancelled);
  const result = parseUhcEligibilityResultText(await readScopedUhcResultText(page));
  const extracted = extractedFieldCount(result);
  if (extracted === 0) {
    throw new Error("The result page loaded, but none of the requested UHC fields could be extracted.");
  }
  return result;
}
async function saveUhcWorkbook(
  workbook: ExcelJS.Workbook,
  jobId: string,
  filename: string,
): Promise<{ output: Buffer; outputPath: string }> {
  const output = Buffer.from(await workbook.xlsx.writeBuffer());
  const safeJobId = jobId.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const outputDirectory = path.join(process.cwd(), "data", "outputs", "uhc", safeJobId);
  await mkdir(outputDirectory, { recursive: true });
  const outputPath = path.join(outputDirectory, filename);
  await writeFile(outputPath, output);
  return { output, outputPath };
}
export async function runUhcWellmedEligibilityWorkflow(options: {
  page: Page;
  inputFile: File;
  context: AutomationContext;
}): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await options.inputFile.arrayBuffer());
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("The UHC eligibility workbook does not contain a worksheet.");
  const rows = readInputRows(sheet);
  const outputStart = addOutputColumns(sheet);

  await openEligibilitySearch(options.page);
  await options.context.emit({ type: "progress", completed: 0, total: rows.length });
  let processedRows = 0;
  let cancelled = false;
  for (let index = 0; index < rows.length; index += 1) {
    if (options.context.isCancelled?.()) {
      cancelled = true;
      break;
    }
    const row = rows[index];
    let result = outputTemplate();
    await options.context.log({
      level: "info",
      message: `Processing UHC row ${row.worksheetRow} (${index + 1} of ${rows.length}).`,
      rowIndex: row.worksheetRow,
      eventName: "eligibility_uhc_row_started",
    });
    await options.context.emit({
      type: "progress",
      completed: index,
      total: rows.length,
      currentRow: row.worksheetRow,
    });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        result = await searchAndExtractUhcRow(options.page, row, index > 0 && attempt === 1, options.context.isCancelled);
        const extracted = extractedFieldCount(result);
        await options.context.log({
          level: "info",
          message: `Extracted ${extracted} of ${UHC_OUTPUT_HEADERS.length} UHC fields for row ${row.worksheetRow}.`,
          rowIndex: row.worksheetRow,
          eventName: "eligibility_uhc_row_extracted",
        });
        await options.context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: result });
        break;
      } catch (error) {
        if (error instanceof UhcCancellation || options.context.isCancelled?.()) {
          cancelled = true;
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (attempt === 1 && shouldRetryNoResult(message)) {
          await options.context.log({
            level: "warn",
            message: `UHC row ${row.worksheetRow} returned "${message}". Retrying this member search once.`,
            rowIndex: row.worksheetRow,
            eventName: "eligibility_uhc_no_result_retry",
          });
          await dismissPortalError(options.page);
          continue;
        }

        result.Error = message;
        await options.context.log({ level: "error", message: `UHC row ${row.worksheetRow} failed: ${message}`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_row_failed" });
        const screenshot = await options.page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
        if (screenshot) await options.context.emit({ type: "error_screenshot", index: row.worksheetRow, image: screenshot.toString("base64") });
        await options.context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: result });
        await dismissPortalError(options.page);
        break;
      }
    }
    if (cancelled) break;
    UHC_OUTPUT_HEADERS.forEach((header, offset) => {
      const cell = sheet.getRow(row.worksheetRow).getCell(outputStart + offset);
      cell.value = result[header] || "-";
      cell.alignment = { vertical: "top", wrapText: true };
    });
    processedRows = index + 1;
    await options.context.emit({ type: "progress", completed: processedRows, total: rows.length, currentRow: row.worksheetRow });
    if (processedRows % UHC_SAVE_INTERVAL === 0) {
      const checkpoint = await saveUhcWorkbook(
        workbook,
        options.context.jobId,
        "uhc-wellmed-eligibility-checkpoint.xlsx",
      ).catch(() => null);
      if (checkpoint) {
        await options.context.log({
          level: "info",
          message: `Saved UHC backup checkpoint after ${processedRows} rows to ${checkpoint.outputPath}.`,
          eventName: "eligibility_uhc_checkpoint_saved",
        });
      }
    }
    if (options.context.isCancelled?.()) {
      cancelled = true;
      break;
    }
  }

  if (cancelled) {
    for (let index = processedRows; index < rows.length; index += 1) {
      UHC_OUTPUT_HEADERS.forEach((header, offset) => {
        const cell = sheet.getRow(rows[index].worksheetRow).getCell(outputStart + offset);
        cell.value = header === "Error" ? "Cancelled - not processed" : "-";
        cell.alignment = { vertical: "top", wrapText: true };
      });
    }
    await options.context.log({
      level: "warn",
      message: `UHC cancellation detected. Finalizing the partial workbook with ${processedRows} of ${rows.length} rows processed.`,
      eventName: "eligibility_uhc_partial_output_finalizing",
    });
  } else {
    await options.context.log({
      level: "info",
      message: `All ${processedRows} UHC rows processed. Finalizing the output workbook.`,
      eventName: "eligibility_uhc_output_finalizing",
    });
  }

  const outputFilename = cancelled
    ? "uhc-wellmed-eligibility-partial-results.xlsx"
    : "uhc-wellmed-eligibility-results.xlsx";
  const { output, outputPath } = await saveUhcWorkbook(
    workbook,
    options.context.jobId,
    outputFilename,
  );
  await options.context.log({
    level: "info",
    message: `Saved the UHC workbook to ${outputPath}.`,
    eventName: "eligibility_uhc_output_saved",
  });
  await options.context.emit({
    type: "file_download",
    filename: outputFilename,
    path: outputPath,
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64: output.toString("base64"),
  });
  await options.context.log({
    level: cancelled ? "warn" : "info",
    message: cancelled
      ? `Downloaded the partial UHC workbook with ${processedRows} processed row(s).`
      : `Downloaded the completed UHC workbook with ${processedRows} processed row(s).`,
    eventName: cancelled ? "eligibility_uhc_partial_output_created" : "eligibility_uhc_output_created",
  });
}
