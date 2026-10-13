import ExcelJS from "exceljs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Frame, Locator, Page } from "playwright-core";
import type { AutomationContext } from "../../../../../types";
import { applyUhcResultLayout } from "./result-parser";
import { isAllowedPlanType, isMedicaidPlanType, selectPolicy, type SelectPolicyResult } from "./policy-selector";

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

type UhcSkippedInputRow = {
  worksheetRow: number;
  payerName: string;
  error: string;
};

type UhcInputRouting = {
  rows: UhcInputRow[];
  skippedRows: UhcSkippedInputRow[];
  totalRows: number;
};

const UHC_SAVE_INTERVAL = 5;

const SELECTORS = {
  eligibilityLink: "div[data-testid='eligibility-link']",
  memberId: "#eligibility-memberid-input, input[name='search.memberId'], input[data-testid='eligibility-search-member-id-abyss-text-input'], input[aria-label*='Member ID' i], input[placeholder*='Member ID' i]",
  dateOfBirth: "#eligibility-dateofbirth-input, input[name='search.dateOfBirth'], input[name='search.dob'], input[data-testid='eligibility-search-DOB-abyss-date-picker-input'], input[aria-label*='Date of Birth' i], input[placeholder*='Date of Birth' i], input[placeholder*='MM/DD/YYYY' i]",
  submit: "button#submit-search-button, button:has-text('Verify Eligibility'), button[data-testid='submit-search-button-abyss-button-root']",
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
      if (normalizedLine === alias) {
        for (let valueIndex = index + 1; valueIndex <= Math.min(index + 5, lines.length - 1); valueIndex += 1) {
          const value = lines[valueIndex] ?? "";
          if (/^(?:keyboard_arrow_(?:down|up)|expand_(?:more|less)|arrow_drop_(?:down|up))$/i.test(value)) continue;
          return value;
        }
        return "";
      }
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

const PAYER_HEADERS = [
  "Payer",
  "Payer Name",
  "Insurance",
  "Insurance Name",
  "Primary Insurance",
  "Primary Insurance Name",
  "Primary Insurance Payer",
  "Primary Insurance Payer Name",
  "Primary Insurance Payer State",
];

function normalizePayer(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isSupportedUhcPayer(payerName: string): boolean {
  const normalized = normalizePayer(payerName);
  return normalized.includes("uhc")
    || normalized.includes("unitedhealth")
    || normalized.includes("wellmed")
    || normalized.includes("surest");
}

function unsupportedPayerError(payerName: string): string {
  return `Unsupported UHC eligibility payer "${payerName}" in the input workbook. Expected UHC, United Healthcare, United Health Care, United Healthcare Dual Complete, UHC Medicare Advantage, United Health Choice Plus Network, United Healthcare Community Plan TX, AARP Medicare Advantage Wellmed, Surest, or Wellmed.`;
}

export function readUhcEligibilityInputRows(sheet: ExcelJS.Worksheet): UhcInputRouting {
  const headers = new Map<string, number>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
    headers.set(normalizedHeader(cellText(cell.value)), column);
  });
  const payerColumn = findColumn(headers, PAYER_HEADERS);
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
  const skippedRows: UhcSkippedInputRow[] = [];
  for (let worksheetRow = 2; worksheetRow <= sheet.rowCount; worksheetRow += 1) {
    const row = sheet.getRow(worksheetRow);
    const memberId = cellText(row.getCell(memberColumn).value);
    const dateOfBirth = cellText(row.getCell(dobColumn).value);
    if (!memberId && !dateOfBirth) continue;
    const payerName = payerColumn ? cellText(row.getCell(payerColumn).value) : "";
    if (payerColumn) {
      if (!payerName) {
        skippedRows.push({
          worksheetRow,
          payerName,
          error: `Missing payer name in row ${worksheetRow}. Add a UHC payer name or remove the payer column for a dedicated UHC workbook.`,
        });
        continue;
      }
      if (!isSupportedUhcPayer(payerName)) {
        skippedRows.push({ worksheetRow, payerName, error: unsupportedPayerError(payerName) });
        continue;
      }
    }
    rows.push({ worksheetRow, memberId, dateOfBirth });
  }
  if (!rows.length && !skippedRows.length) throw new Error("The UHC eligibility workbook does not contain member rows.");
  return { rows, skippedRows, totalRows: rows.length + skippedRows.length };
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

/**
 * Validates UHC eligibility result cards and clicks the Select button
 * on the unique card where all three conditions are met:
 *   - Member ID matches the input row's member ID (trimmed, case-insensitive)
 *   - Coverage Type is one of: Medical, HMO, Health Benefits
 *   - Plan Type is exactly "Medicare Primary"
 *
 * If exactly one card matches, clicks that card's Select button and returns true.
 * If no cards match, logs a message and returns false.
 * If multiple cards match, reports ambiguity and returns false without clicking any button.
 *
 * @returns true if a unique matching card was found and selected, false otherwise.
 */
async function validateAndSelectUhcRow(page: Page, row: UhcInputRow, context: AutomationContext): Promise<boolean> {
  // Scroll down to ensure plan cards are visible (they may render below the fold)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500); // Allow any lazy-loaded content to render

  // Find all eligibility result cards on the page
  const cardClass = 'abyss-c-PJLV abyss-c-PJLV-ikfWlwY-css abyss-box-root';
  const cards = page.locator(cardClass);
  const cardCount = await cards.count();

  if (cardCount === 0) {
    await context.log({ level: "warn", message: `Row ${row.worksheetRow}: No eligibility result cards found on the page.`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_no_cards_found" });
    await context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: { Error: "No eligibility result cards found." } });
    return false;
  }

  // Label span class that identifies field labels
  const LABEL_CLASS = 'abyss-c-PJLV abyss-c-PJLV-ieprGXN-css abyss-text-root';
  const VALUE_CLASS = 'abyss-c-PJLV abyss-c-PJLV-iiXMgHe-css abyss-text-root';

  // Collect all cards that pass all three validation conditions
  const matchingCards: { card: Locator; cardIdx: number }[] = [];

  // Normalize the input member ID once for comparison
  const normalizedInputMemberId = row.memberId.trim().toLowerCase();

  // Allowed coverage types (normalized to lowercase)
  const allowedCoverageTypes = new Set(["medical", "hmo", "health benefits"]);

  // Try each card and collect those that pass all validations
  for (let cardIdx = 0; cardIdx < cardCount; cardIdx += 1) {
    const card = cards.nth(cardIdx);

    // Extract label-value pairs from this card
    const labelSpans = card.locator(LABEL_CLASS);
    const valueSpans = card.locator(VALUE_CLASS);
    const spanCount = await valueSpans.count();

    let cardCoverageType = "";
    let cardPlanType = "";
    let cardMemberId = "";

    // Read all label-value pairs from this card
    for (let i = 0; i < spanCount; i += 1) {
      const labelText = await labelSpans.nth(i).innerText({ timeout: 2_000 });
      const labelTrimmed = labelText.trim();
      const valueText = await valueSpans.nth(i).innerText({ timeout: 2_000 });
      const valueTrimmed = valueText.trim();

      // Identify the field by its label and capture the value
      // Supports optional trailing colon on label: "Coverage Type:" or "Coverage Type"
      if (/^Coverage Type:?$/i.test(labelTrimmed)) {
        cardCoverageType = valueTrimmed;
      } else if (/^Plan Type:?$/i.test(labelTrimmed)) {
        cardPlanType = valueTrimmed;
      } else if (/^Member ID:?$/i.test(labelTrimmed)) {
        cardMemberId = valueTrimmed;
      }
    }

    // Normalize card values for comparison
    const normalizedCardMemberId = cardMemberId.trim().toLowerCase();
    const normalizedCardCoverageType = cardCoverageType.trim().toLowerCase();
    const normalizedCardPlanType = cardPlanType.trim().toLowerCase();

    // Check all three conditions
    const coverageValid = allowedCoverageTypes.has(normalizedCardCoverageType);
    const planTypeValid = normalizedCardPlanType === "medicare primary";
    const memberIdValid = normalizedCardMemberId === normalizedInputMemberId;

    if (coverageValid && planTypeValid && memberIdValid) {
      matchingCards.push({ card, cardIdx: cardIdx + 1 }); // Use 1-based index for logging
    }
  }

  // Decide action based on number of matching cards
  if (matchingCards.length === 1) {
    // Exactly one card matches - click its Select button
    const { card } = matchingCards[0];
    const selectButton = card.locator('button:has-text("Select")').first();
    const selectButtonCount = await selectButton.count();
    if (selectButtonCount === 0) {
      await context.log({ level: "warn", message: `Row ${row.worksheetRow} Matching card Select button not found.`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_select_button_not_found" });
      await context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: { Error: "Select button not found on matching card." } });
      return false;
    }

    await selectButton.scrollIntoViewIfNeeded().catch(() => {});
    await selectButton.waitFor({ state: "visible", timeout: 20_000 });
    await selectButton.click({ timeout: 5_000 });

    await page.waitForTimeout(1_000); // allow the selection to settle

    await context.log({ level: "info", message: `Row ${row.worksheetRow}: Unique matching card found (Card ${matchingCards[0].cardIdx}). Select button clicked.`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_selection_passed" });
    await context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: { Selection: "Passed" } });
    return true;
  } else if (matchingCards.length === 0) {
    // No cards match - log and return false without clicking
    await context.log({ level: "warn", message: `Row ${row.worksheetRow}: No eligibility result cards matched the validation criteria (Member ID, Coverage Type, Plan Type).`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_no_matching_card" });
    await context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: { Error: "No matching eligibility result card found." } });
    return false;
  } else {
    // Multiple cards match - report ambiguity, do not click any button
    await context.log({ level: "warn", message: `Row ${row.worksheetRow}: Ambiguity - ${matchingCards.length} cards matched the validation criteria. Selection aborted.`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_ambiguous_match" });
    await context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: { Error: `${matchingCards.length} matching cards found - selection ambiguous.` } });
    return false;
  }
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
  const normalized = (input: string) => input.toLowerCase().replace(/[^a-z0-9]+/g, "");
  let retainedValue = await field.inputValue();
  if (normalized(retainedValue) !== normalized(value)) {
    // UHC occasionally rerenders a controlled input while keys are being sent.
    // Re-resolve the same attached field through fill, which emits an input event.
    await field.fill(value);
    await page.waitForTimeout(500);
    retainedValue = await field.inputValue();
  }
  if (!normalized(retainedValue) || normalized(retainedValue) !== normalized(value)) {
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

async function optionalVisibleText(page: Page | Frame, locator: Locator): Promise<string> {
  if (await locator.count().catch(() => 0) === 0) return "";
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);
  return locator.innerText({ timeout: 2_000 }).catch(() => "");
}

async function textAroundAnyLabel(
  page: Page | Frame,
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
async function firstVisibleCandidate(page: Page | Frame, candidates: Locator, timeout = 10_000): Promise<Locator | null> {
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
async function controlledSectionText(page: Page | Frame, trigger: Locator): Promise<string> {
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
async function labeledRowText(page: Page | Frame, candidates: Locator, labels: RegExp): Promise<string> {
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
async function readScopedUhcResultText(page: Page | Frame): Promise<string> {
  const expandableSummarySections = page.locator("button[aria-expanded='false']").filter({
    hasText: /Member (?:Information|Details|Summary)|Coverage (?:Information|Details|Summary)|Eligibility Details|Policy (?:Information|Details)/i,
  });
  const expandableCount = await expandableSummarySections.count().catch(() => 0);
  for (let index = 0; index < expandableCount; index += 1) {
    const section = expandableSummarySections.nth(index);
    if (!await section.isVisible().catch(() => false)) continue;
    await section.scrollIntoViewIfNeeded().catch(() => {});
    await section.click().catch(() => {});
    await page.waitForTimeout(800);
  }

  const policyLocator = page.locator("ul").filter({ hasText: /Policy Selected:/i }).first();
  const policy = await optionalVisibleText(page, policyLocator);

  const memberSummary = await labeledRowText(
    page,
    page.getByText(/^(?:Coverage Status|Member Status|Effective Date|Termination Date|End Date|Relationship to Subscriber)$/i),
    /^(?:Coverage Status|Member Status|Effective Date|Termination Date|End Date|Relationship to Subscriber)$/i,
  );

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

  // UHC renders the member summary (status, dates and relationship) outside the
  // benefit cards below. Keep the targeted card text, but also capture the full
  // result DOM after scrolling/expanding has caused lazy sections to render.
  const fullResultPage = await page.locator("body").innerText({ timeout: 10_000 }).catch(() => "");

  return [
    policy,
    memberSummary,
    "UNITEDHEALTHCARE",
    plan,
    "Coordination of Benefits",
    coordination,
    "Deductibles & Maximums",
    deductibles,
    "POPULAR SERVICES COVERAGE",
    popular,
    fullResultPage,
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
  const candidates = page.locator(SELECTORS.newSearch).filter({ hasText: /New or recent search/i });
  while (Date.now() < deadline) {
    const count = await candidates.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = candidates.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("A visible UHC New or recent search button was not found after the eligibility response.");
}

async function openNewSearchForm(page: Page): Promise<void> {
  // A failed lookup can leave UHC on the search form already. In that state there
  // is no New Search button, so waiting for one prevents every later row running.
  if (await hasVisibleSearchForm(page)) return;

  const button = await visibleNewSearchButton(page);
  await button.scrollIntoViewIfNeeded().catch(() => {});
  await button.waitFor({ state: "visible" });
  await button.click();
  // UHC replaces the initial panel DOM during its opening animation. Wait for
  // that replacement before resolving fresh input locators for the next row.
  await page.waitForTimeout(1_500);
  try {
    await firstVisibleLocator(page, SELECTORS.memberId, 25_000, "Member ID field");
    await firstVisibleLocator(page, SELECTORS.dateOfBirth, 25_000, "date of birth field");
    return;
  } catch {
    // Some UHC result pages acknowledge New Search without replacing the result
    // panel. Re-enter through Eligibility once before failing only this row.
    const eligibility = page.locator(SELECTORS.eligibilityLink).filter({ hasText: /^\s*Eligibility\s*$/ });
    const count = await eligibility.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const link = eligibility.nth(index);
      if (!(await link.isVisible().catch(() => false))) continue;
      await link.click().catch(() => {});
      break;
    }
    await firstVisibleLocator(page, SELECTORS.memberId, 20_000, "Member ID field");
    await firstVisibleLocator(page, SELECTORS.dateOfBirth, 20_000, "date of birth field");
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
  let lastLog = 0;

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

    // Also check for plan-type element as alternative stability indicator
    let planTypeVisible = false;
    const planTypeCount = await page.getByTestId("plan-type").count().catch(() => 0);
    if (planTypeCount > 0) {
      for (let index = 0; index < planTypeCount; index += 1) {
        if (await page.getByTestId("plan-type").nth(index).isVisible().catch(() => false)) {
          planTypeVisible = true;
          break;
        }
      }
    }

    const isStable = !formVisible && (policyVisible || planTypeVisible);

    if (isStable) {
      const current = await page.locator("body").innerText();
      stableReads = current === previous ? stableReads + 1 : 0;
      previous = current;
      if (stableReads >= 2) {
        console.log(`[waitForFreshResult] Stable after ${stableReads} reads (policyVisible=${policyVisible}, planTypeVisible=${planTypeVisible})`);
        return;
      }
    } else {
      previous = "";
      stableReads = 0;
    }

    // Periodic logging
    if (Date.now() - lastLog >= 10_000) {
      console.log(`[waitForFreshResult] Waiting... formVisible=${formVisible} policyVisible=${policyVisible} planTypeVisible=${planTypeVisible} stableReads=${stableReads}`);
      lastLog = Date.now();
    }

    // Scroll down to trigger lazy-loaded content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await page.waitForTimeout(750);
  }

  // Diagnostic on timeout
  const formVisible = await hasVisibleSearchForm(page);
  let policyVisible = false;
  const policyCount = await policyBanner.count();
  for (let index = 0; index < policyCount; index += 1) {
    if (await policyBanner.nth(index).isVisible().catch(() => false)) {
      policyVisible = true;
      break;
    }
  }
  let planTypeVisible = false;
  const planTypeCount = await page.getByTestId("plan-type").count().catch(() => 0);
  if (planTypeCount > 0) {
    for (let index = 0; index < planTypeCount; index += 1) {
      if (await page.getByTestId("plan-type").nth(index).isVisible().catch(() => false)) {
        planTypeVisible = true;
        break;
      }
    }
  }
  await page.screenshot({ path: "waitForFreshResult-timeout.png", fullPage: true }).catch(() => {});
  throw new Error(
    `The UHC search form did not transition to a stable eligibility result page. ` +
    `formVisible=${formVisible} policyVisible=${policyVisible} planTypeVisible=${planTypeVisible} ` +
    `stableReads=${stableReads}`
  );
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

function writeUhcOutputRow(
  sheet: ExcelJS.Worksheet,
  worksheetRow: number,
  outputStart: number,
  result: UhcEligibilityOutput,
): void {
  UHC_OUTPUT_HEADERS.forEach((header, offset) => {
    const cell = sheet.getRow(worksheetRow).getCell(outputStart + offset);
    cell.value = result[header] || "-";
    cell.alignment = { vertical: "top", wrapText: true };
  });
}

export function shouldRetryNoResult(message: string): boolean {
  return /^No Results Found$/i.test(message.trim())
    || /no results with the Member ID you submitted/i.test(message);
}

async function searchAndExtractUhcRow(
  page: Page,
  context: BrowserContext,
  row: UhcInputRow,
  openNewSearch: boolean,
  isCancelled?: () => boolean,
): Promise<UhcEligibilityOutput> {
  if (openNewSearch) await openNewSearchForm(page);
  await enterSearch(page, row);

  // Detect which page we landed on after search
  const landing = await detectLandingPage(page, 30_000, row.memberId);
  let ctx: Page | Frame = page;

  if (landing === "no-policies") {
    console.log(`No policies available for Member ID "${row.memberId}".`);
    await closeNoPolicyModal(page);
    throw new Error(`NO_POLICIES: No policies available for Member ID "${row.memberId}".`);
  }

  if (landing === "results") {
    console.log("[searchAndExtractUhcRow] Landed on Member Search Results page, running selectPolicy");
    const policyResult: SelectPolicyResult = await selectPolicy(page, context, row.memberId);
    if (!policyResult.selected) {
      console.log(`No matching policy found for Member ID "${row.memberId}".`);
      await goBackToSearch(policyResult.ctx, page);
      throw new Error(`NO_MATCHING_POLICY: No matching policy found for Member ID "${row.memberId}".`);
    }
    ctx = policyResult.ctx;
  } else {
    console.log("[searchAndExtractUhcRow] Landed on Eligibility Details page, skipping selectPolicy");
    await waitForFreshResult(page, isCancelled);

    // Check Plan Type on details page - allow Medicaid as fallback
    const planType = await readDetailsPlanType(page);
    console.log(`[searchAndExtractUhcRow] Details page Plan Type: "${planType}"`);
    if (!isAllowedPlanType(planType) && !isMedicaidPlanType(planType)) {
      console.log(`No matching policy found for Member ID "${row.memberId}".`);
      throw new Error(`NO_MATCHING_PLAN_TYPE: Plan Type "${planType}" not in allowed list for Member ID "${row.memberId}".`);
    }
  }

  const result = parseUhcEligibilityResultText(await readScopedUhcResultText(ctx));
  const extracted = extractedFieldCount(result);
  if (extracted === 0) {
    throw new Error("The result page loaded, but none of the requested UHC fields could be extracted.");
  }
  return result;
}

/**
 * Click Back button to return from Member Search Results to search form.
 * Clears old input values so the next member can be entered cleanly.
 */
async function goBackToSearch(ctx: Page | Frame, page: Page): Promise<void> {
  const backButton = ctx
    .getByTestId("header-back-button-abyss-button-root")
    .or(ctx.getByRole("button", { name: "Back", exact: true }))
    .first();
  await backButton.waitFor({ state: "visible", timeout: 10_000 });
  await backButton.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await backButton.click({ timeout: 5_000 });
  } catch {
    await backButton.evaluate((el) => (el as HTMLElement).click());
  }

  // Poll until Select buttons are gone (back on search form)
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const selectCount = await ctx.getByRole("button", { name: "Select", exact: true }).count().catch(() => 0);
    if (selectCount === 0) {
      console.log("[goBackToSearch] Returned to search form");
      return;
    }
    await page.waitForTimeout(300);
  }
  throw new Error("goBackToSearch: Timed out waiting for Select buttons to disappear.");
}

/**
 * Reads the Plan Type from the eligibility details page.
 * Polls page and all frames for getByTestId("plan-type"), returns the sibling span's text.
 * Throws on timeout.
 */
async function readDetailsPlanType(page: Page, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const contexts: (Page | Frame)[] = [page];
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) contexts.push(frame);
    }

    for (const ctx of contexts) {
      const locator = ctx.getByTestId("plan-type").first();
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;

      const value = await locator
        .evaluate((el) => {
          const sibling = el.nextElementSibling;
          if (sibling) return sibling.textContent?.trim() ?? "";
          const parentSpan = el.parentElement?.querySelector(":scope > span");
          return parentSpan?.textContent?.trim() ?? "";
        })
        .catch(() => "");

      if (value) return value;
    }

    await page.waitForTimeout(500);
  }

  throw new Error("Plan Type not found on eligibility details page");
}

/**
 * Text shown in the "No policies available for this member" modal.
 */
const NO_POLICY_TEXT = /No policies available for this member/i;

/**
 * Normalizes an ID by stripping non-alphanumerics and leading zeros.
 */
function normId(id?: string): string {
  if (!id) return "";
  return id.replace(/[^a-z0-9]/gi, "").replace(/^0+/, "") || "0";
}

/**
 * Checks if two IDs refer to the same member.
 * Equal after normalization, OR both lengths >= 6 and one contains the other.
 */
function sameMember(a?: string, b?: string): boolean {
  const na = normId(a);
  const nb = normId(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 6 && nb.length >= 6) {
    return na.includes(nb) || nb.includes(na);
  }
  return false;
}

/**
 * Extracts memberId from URL payload (hash or query).
 * Expected format: #/eligibility/search-results?memberId=... or similar.
 */
function readUrlPayload(url: string): { memberId?: string } {
  try {
    const hashIndex = url.indexOf("#");
    const searchPart = hashIndex >= 0 ? url.slice(hashIndex + 1) : url;
    const queryIndex = searchPart.indexOf("?");
    if (queryIndex < 0) return {};
    const params = new URLSearchParams(searchPart.slice(queryIndex + 1));
    const memberId = params.get("memberId") ?? params.get("member_id") ?? params.get("id");
    return { memberId: memberId ?? undefined };
  } catch {
    return {};
  }
}

/**
 * Logs the URL and page headings so a hung landing can be diagnosed manually.
 */
async function logLandingDiagnostics(page: Page): Promise<void> {
  const url = page.url();
  const headings: string[] = [];
  for (const tag of ["h1", "h2", "h3"]) {
    const texts = await page.locator(tag).allInnerTexts().catch(() => []);
    headings.push(...texts);
  }
  console.log(`[detectLandingPage] Polling: URL: ${url} | headings: ${headings.join(" | ")}`);
}

/**
 * Closes the "No policies available for this member" modal via its X (Close) button.
 * Throws if the modal is not found.
 */
async function closeNoPolicyModal(page: Page): Promise<void> {
  const contexts: (Page | Frame)[] = [page];
  for (const frame of page.frames()) {
    if (frame !== page.mainFrame()) contexts.push(frame);
  }

  let modalCtx: Page | Frame | null = null;
  for (const ctx of contexts) {
    const count = await ctx.getByText(NO_POLICY_TEXT).count().catch(() => 0);
    if (count > 0) {
      modalCtx = ctx;
      break;
    }
  }
  if (!modalCtx) throw new Error("No policies modal was not found.");

  const closeButton = modalCtx
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .or(modalCtx.locator("button.abyss-modal-close-button"))
    .first();
  await closeButton.waitFor({ state: "visible", timeout: 10_000 });
  await closeButton.click();
  await modalCtx.getByText(NO_POLICY_TEXT).first().waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  console.log("[closeNoPolicyModal] closed modal");
}

type LandingPage = "results" | "details" | "no-policies";

/**
 * Detects which page we landed on after clicking Search.
 * Polls every 500ms over [page, ...page.frames()] and computes:
 *   - modal: text /No policies available for this member/i exists
 *   - selectCount: sum of getByRole("button", {name: "Select", exact: true}).count()
 *   - planTypeValue: getByTestId("plan-type").first() -> trimmed textContent of nextElementSibling (with fallback)
 *   - urlMatchesMember: readUrlPayload(page.url()).memberId exists AND matches input memberId via sameMember
 * Decision order:
 *   1) modal -> "no-policies"
 *   2) selectCount > 0 -> "results"
 *   3) planTypeValue non-empty -> wait 1500ms, re-check modal, else "details"
 * A missing URL payload must NOT count as matching for urlMatchesMember.
 * Every 2s logs signals. On timeout saves screenshot and throws.
 */
async function detectLandingPage(page: Page, timeoutMs = 30_000, memberId?: string): Promise<LandingPage> {
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;

  while (Date.now() < deadline) {
    // Strong signal: URL indicates results page (check FIRST, before frames)
    const url = page.url();
    if (url.includes("/eligibility/search-results")) {
      console.log(`[detectLandingPage] URL indicates results page: ${url}`);
      return "results";
    }

    // Collect page + all frames
    const contexts: (Page | Frame)[] = [page];
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame()) contexts.push(frame);
    }

    // Compute signals across all contexts
    let modal = false;
    let selectCount = 0;
    let planTypeValue = "";
    let planTypeContext: Page | Frame | null = null;

    for (const ctx of contexts) {
      // modal: text /No policies available for this member/i exists
      const noPolicyCount = await ctx.getByText(NO_POLICY_TEXT).count().catch(() => 0);
      if (noPolicyCount > 0) modal = true;

      // selectCount: sum of exact Select buttons
      const count = await ctx.getByRole("button", { name: "Select", exact: true }).count().catch(() => 0);
      selectCount += count;

      // planTypeValue: first plan-type with non-empty sibling (with fallback like readDetailsPlanType)
      // ONLY record if we haven't found Select buttons yet (results page takes priority)
      if (!planTypeValue && selectCount === 0) {
        const planTypeCount = await ctx.getByTestId("plan-type").count().catch(() => 0);
        if (planTypeCount > 0) {
          const value = await ctx.getByTestId("plan-type").first()
            .evaluate((el) => {
              const sibling = el.nextElementSibling;
              if (sibling) return sibling.textContent?.trim() ?? "";
              const parentSpan = el.parentElement?.querySelector(":scope > span");
              return parentSpan?.textContent?.trim() ?? "";
            })
            .catch(() => "");
          if (value) {
            planTypeValue = value;
            planTypeContext = ctx;
          }
        }
      }
    }

    // urlMatchesMember: readUrlPayload(page.url()).memberId exists AND matches input memberId via sameMember
    const urlPayload = readUrlPayload(page.url());
    const urlHasPolicy = !!urlPayload.memberId;
    const urlMatchesMember = urlHasPolicy && !!memberId && sameMember(urlPayload.memberId, memberId);

    // Periodic logging every 2s
    if (Date.now() - lastLog >= 2_000) {
      console.log(
        `[workflow] signals: modal=${modal} selectButtons=${selectCount} ` +
        `planTypeHasValue=${!!planTypeValue} urlHasPolicy=${urlHasPolicy} urlMatchesMember=${urlMatchesMember}`
      );
      lastLog = Date.now();
    }

    // Decision order - RESULTS PAGE TAKES PRIORITY OVER DETAILS
    // 1) modal -> "no-policies"
    if (modal) {
      console.log("[workflow] landed on: no-policies");
      return "no-policies";
    }

    // 2) selectCount > 0 -> "results" (RESULTS PAGE CHECKED BEFORE DETAILS)
    if (selectCount > 0) {
      console.log(`[workflow] landed on: results (${selectCount} Select button(s))`);
      return "results";
    }

    // 3) planTypeValue non-empty AND no Select buttons found -> wait 1500ms, re-check modal + Select buttons, else "details"
    if (planTypeValue && selectCount === 0) {
      await page.waitForTimeout(1_500);

      // Re-check modal AND Select buttons after wait
      let modalAfterWait = false;
      let selectCountAfterWait = 0;
      for (const ctx of contexts) {
        const noPolicyCount = await ctx.getByText(NO_POLICY_TEXT).count().catch(() => 0);
        if (noPolicyCount > 0) modalAfterWait = true;
        const count = await ctx.getByRole("button", { name: "Select", exact: true }).count().catch(() => 0);
        selectCountAfterWait += count;
      }
      if (modalAfterWait) {
        console.log("[workflow] landed on: no-policies (modal appeared after wait)");
        return "no-policies";
      }
      if (selectCountAfterWait > 0) {
        console.log(`[workflow] landed on: results (Select buttons appeared after wait: ${selectCountAfterWait})`);
        return "results";
      }
      console.log("[workflow] landed on: details");
      return "details";
    }

    await page.waitForTimeout(500);
  }

  // Timeout: dump diagnostics
  await page.screenshot({ path: "landing-unknown.png", fullPage: true }).catch(() => {});
  await logLandingDiagnostics(page);
  throw new Error("detectLandingPage: Timed out waiting for results, details, or no-policies page.");
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
  const routing = readUhcEligibilityInputRows(sheet);
  const { rows, skippedRows, totalRows } = routing;
  const outputStart = addOutputColumns(sheet);

  for (const skipped of skippedRows) {
    const result = outputTemplate();
    result.Error = skipped.error;
    writeUhcOutputRow(sheet, skipped.worksheetRow, outputStart, result);
    await options.context.log({
      level: "warn",
      message: skipped.error,
      rowIndex: skipped.worksheetRow,
      eventName: "eligibility_uhc_input_row_skipped",
      meta: { payerName: skipped.payerName },
    });
    await options.context.emit({ type: "eligibility_uhc_result", rowIndex: skipped.worksheetRow, update: result });
  }

  await options.context.emit({ type: "progress", completed: skippedRows.length, total: totalRows });
  if (!rows.length) {
    await options.context.log({
      level: "warn",
      message: `No supported UHC rows were found. Finalizing the workbook with ${skippedRows.length} skipped row(s).`,
      eventName: "eligibility_uhc_no_supported_rows",
    });
    const { output, outputPath } = await saveUhcWorkbook(
      workbook,
      options.context.jobId,
      "uhc-wellmed-eligibility-results.xlsx",
    );
    await options.context.log({
      level: "info",
      message: `Saved the UHC workbook to ${outputPath}.`,
      eventName: "eligibility_uhc_output_saved",
    });
    await options.context.emit({
      type: "file_download",
      filename: "uhc-wellmed-eligibility-results.xlsx",
      path: outputPath,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64: output.toString("base64"),
    });
    await options.context.emit({ type: "progress", completed: totalRows, total: totalRows });
    return;
  }

  await openEligibilitySearch(options.page);
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
      completed: skippedRows.length + index,
      total: totalRows,
      currentRow: row.worksheetRow,
    });

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        // Get the browser context from the page
        const browserContext = options.page.context();
        result = await searchAndExtractUhcRow(options.page, browserContext, row, index > 0 && attempt === 1, options.context.isCancelled);
        const extracted = extractedFieldCount(result);
        await options.context.log({
          level: "info",
          message: `Extracted ${extracted} of ${UHC_OUTPUT_HEADERS.length} UHC fields for row ${row.worksheetRow}.`,
          rowIndex: row.worksheetRow,
          eventName: "eligibility_uhc_row_extracted",
        });

        // Validate the result and click Select if conditions pass
        const validationPassed = await validateAndSelectUhcRow(options.page, row, options.context);
        if (!validationPassed) {
          // Validation failed - row should be skipped, don't proceed with selection
          // The validateAndSelectUhcRow already emitted the error and result
          break;
        }

        await options.context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: result });
        break;
      } catch (error) {
        if (error instanceof UhcCancellation || options.context.isCancelled?.()) {
          cancelled = true;
          break;
        }
        const message = error instanceof Error ? error.message : String(error);
        // Handle "no matching policy" as a skip, not a failure
        if (message.startsWith("NO_MATCHING_POLICY:") || message.startsWith("NO_MATCHING_PLAN_TYPE:")) {
          const cleanMessage = message.replace(/^NO_MATCHING_(?:POLICY|PLAN_TYPE): /, "");
          result.Error = cleanMessage;
          await options.context.log({ level: "warn", message: `UHC row ${row.worksheetRow} skipped: ${cleanMessage}`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_no_matching_policy" });
          await options.context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: result });
          await options.context.log({ level: "warn", message: `Skipping UHC row ${row.worksheetRow} (no matching policy) and continuing with the next input row.`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_row_skipped" });
          break;
        }
        // Handle "no policies" as a skip, not a failure
        if (message.startsWith("NO_POLICIES:")) {
          const cleanMessage = message.replace("NO_POLICIES: ", "");
          result.Error = cleanMessage;
          await options.context.log({ level: "warn", message: `UHC row ${row.worksheetRow} skipped: ${cleanMessage}`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_no_policies" });
          await options.context.emit({ type: "eligibility_uhc_result", rowIndex: row.worksheetRow, update: result });
          await options.context.log({ level: "warn", message: `Skipping UHC row ${row.worksheetRow} (no policies) and continuing with the next input row.`, rowIndex: row.worksheetRow, eventName: "eligibility_uhc_row_skipped" });
          break;
        }
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
        await options.context.log({
          level: "warn",
          message: `Skipping failed UHC row ${row.worksheetRow} and continuing with the next input row.`,
          rowIndex: row.worksheetRow,
          eventName: "eligibility_uhc_row_skipped",
        });
        break;
      }
    }
    if (cancelled) break;
    writeUhcOutputRow(sheet, row.worksheetRow, outputStart, result);
    processedRows = index + 1;
    await options.context.emit({
      type: "progress",
      completed: skippedRows.length + processedRows,
      total: totalRows,
      currentRow: row.worksheetRow,
    });
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
      const result = outputTemplate();
      result.Error = "Cancelled - not processed";
      writeUhcOutputRow(sheet, rows[index].worksheetRow, outputStart, result);
    }
    await options.context.log({
      level: "warn",
      message: `UHC cancellation detected. Finalizing the partial workbook with ${processedRows} of ${rows.length} supported row(s) processed and ${skippedRows.length} skipped row(s).`,
      eventName: "eligibility_uhc_partial_output_finalizing",
    });
  } else {
    await options.context.log({
      level: "info",
      message: `All ${processedRows} supported UHC row(s) processed with ${skippedRows.length} skipped row(s). Finalizing the output workbook.`,
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
