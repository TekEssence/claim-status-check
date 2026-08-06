import ExcelJS from "exceljs";
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
] as const;

export type UhcEligibilityOutput = Record<(typeof UHC_OUTPUT_HEADERS)[number], string>;

type UhcInputRow = {
  worksheetRow: number;
  memberId: string;
  dateOfBirth: string;
};

const SELECTORS = {
  eligibilityLink: "[data-testid='eligibility-link']",
  memberId: "#eligibility-memberid-input[data-testid='eligibility-search-member-id-abyss-text-input']",
  dateOfBirth: "#eligibility-dateofbirth-input[data-testid='eligibility-search-DOB-abyss-date-picker-input']",
  submit: "button#submit-search-button",
  newSearch: "button[data-testid='overview-new-search-button-abyss-button-root']",
} as const;

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
  const member = await firstVisibleLocator(page, SELECTORS.memberId, 30_000, "Member ID field");
  const dob = await firstVisibleLocator(page, SELECTORS.dateOfBirth, 30_000, "date of birth field");
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
  selector: string,
  timeout: number,
  label: string,
): Promise<Locator> {
  const deadline = Date.now() + timeout;
  const candidates = page.locator(selector);
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
  await field.waitFor({ state: "visible" });
  await field.click();
  await page.waitForTimeout(500);
  await field.press("Control+A");
  await page.waitForTimeout(250);
  await field.press("Backspace");
  await page.waitForTimeout(300);
  await field.pressSequentially(value, { delay });
  await page.waitForTimeout(700);
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
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    await candidate.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(600);
    const text = await ancestorTextContaining(candidate, required, maxDepth);
    if (text) return text;
  }
  return "";
}

async function controlledSectionText(page: Page, trigger: Locator): Promise<string> {
  if (await trigger.count().catch(() => 0) === 0) return "";
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(800);

  const expanded = await trigger.getAttribute("aria-expanded", { timeout: 2_000 }).catch(() => null);
  if (expanded === "false") {
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

  const deductible = await textAroundAnyLabel(
    page,
    page.getByText(/Plan Deductible Per Calendar Year/i),
    [/Plan Deductible Per Calendar Year/i, /\$/i],
  );
  if (deductible) parts.push(deductible);

  const outOfPocket = await textAroundAnyLabel(
    page,
    page.getByText(/Out-of-Pocket Maximum Per Calendar Year/i),
    [/Out-of-Pocket Maximum Per Calendar Year/i, /\$/i],
  );
  if (outOfPocket) parts.push(outOfPocket);

  if (!parts.length) {
    const fallback = await ancestorTextContaining(trigger, [/Deductibles & Maximums/i, /Deductible|Out-of-Pocket/i]);
    if (fallback) parts.push(fallback);
  }
  return [...new Set(parts)].join(String.fromCharCode(10));
}
async function readScopedUhcResultText(page: Page): Promise<string> {
  const policyLocator = page.locator("ul").filter({ hasText: /Policy Selected:/i }).first();
  const policy = await optionalVisibleText(page, policyLocator);

  const unitedHealthcareHeading = page.locator("h3").filter({ hasText: /^UNITEDHEALTHCARE$/i }).first();
  const plan = await ancestorTextContaining(unitedHealthcareHeading, [/Plan Name/i, /Plan Type/i]);

  const coordinationLocator = page.locator("[data-testid='vendor-coverage-abyss-grid-col']").first();
  const coordination = await optionalVisibleText(page, coordinationLocator);

  const deductibleTrigger = page.locator("button").filter({ hasText: /Deductibles & Maximums/i }).first();
  const deductibles = await controlledSectionText(page, deductibleTrigger);

  const popularHeading = page.getByText("POPULAR SERVICES COVERAGE", { exact: true }).first();
  if (await popularHeading.count().catch(() => 0)) {
    await popularHeading.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(600);
    const popularTrigger = popularHeading.locator("xpath=ancestor::button[1]");
    if (await popularTrigger.count().catch(() => 0)) {
      const expanded = await popularTrigger.getAttribute("aria-expanded", { timeout: 1_000 }).catch(() => null);
      if (expanded === "false") {
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

async function hasVisibleSearchForm(page: Page): Promise<boolean> {
  const candidates = page.locator(SELECTORS.memberId);
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    if (await candidates.nth(index).isVisible().catch(() => false)) return true;
  }
  return false;
}

async function openNewSearchForm(page: Page): Promise<void> {
  await (await visibleNewSearchButton(page)).click();
  await firstVisibleLocator(page, SELECTORS.memberId, 30_000, "Member ID field");
  await firstVisibleLocator(page, SELECTORS.dateOfBirth, 30_000, "date of birth field");
  await page.waitForTimeout(1_000);
}

async function waitForFreshResult(page: Page, timeout = 60_000): Promise<void> {
  const deadline = Date.now() + timeout;
  const policyBanner = page.locator("ul").filter({ hasText: /Policy Selected:/i });
  let previous = "";
  let stableReads = 0;

  while (Date.now() < deadline) {
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
      if (stableReads >= 2) {
        await visibleNewSearchButton(page, 5_000);
        return;
      }
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

  await options.page.locator(SELECTORS.eligibilityLink).click();
  await options.context.emit({ type: "progress", completed: 0, total: rows.length });
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    let result = outputTemplate();
    try {
      await options.context.log({
        level: "info",
        message: `Processing UHC row ${row.worksheetRow}.`,
        rowIndex: row.worksheetRow,
        eventName: "eligibility_uhc_row_started",
      });
      if (index > 0) await openNewSearchForm(options.page);
      await enterSearch(options.page, row);
      await waitForFreshResult(options.page);
      result = parseUhcEligibilityResultText(await readScopedUhcResultText(options.page));
      const extracted = extractedFieldCount(result);
      if (extracted === 0) {
        throw new Error("The result page loaded, but none of the requested UHC fields could be extracted.");
      }
      await options.context.log({
        level: "info",
        message: `Extracted ${extracted} of ${UHC_OUTPUT_HEADERS.length} UHC fields for row ${row.worksheetRow}.`,
        rowIndex: row.worksheetRow,
        eventName: "eligibility_uhc_row_extracted",
      });
      await options.context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await options.context.log({ level: "error", message: `UHC row ${row.worksheetRow} failed: ${message}`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_row_failed" });
      const screenshot = await options.page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
      if (screenshot) await options.context.emit({ type: "error_screenshot", index: row.worksheetRow, image: screenshot.toString("base64") });
    }

    UHC_OUTPUT_HEADERS.forEach((header, offset) => {
      const cell = sheet.getRow(row.worksheetRow).getCell(outputStart + offset);
      cell.value = result[header] || "-";
      cell.alignment = { vertical: "top", wrapText: true };
    });
    await options.context.emit({ type: "progress", completed: index + 1, total: rows.length });
  }

  const output = Buffer.from(await workbook.xlsx.writeBuffer());
  await options.context.emit({
    type: "file_download",
    filename: "uhc-wellmed-eligibility-results.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64: output.toString("base64"),
  });
}
