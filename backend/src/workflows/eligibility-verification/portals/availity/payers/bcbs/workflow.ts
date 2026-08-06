import * as XLSX from "xlsx";
import type { Frame, Locator, Page } from "playwright-core";
import type { AvailityEligibilityPayerWorkflowInput } from "../types";
import { BCBS_AVAILITY_ELIGIBILITY_SELECTORS as SELECTORS } from "./selectors";

const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const normalize = (value: unknown) => String(value ?? "").trim();
const navigationReadyTimeout = Number(
  process.env.PORTAL_AVAILITY_ELIGIBILITY_NAVIGATION_READY_TIMEOUT_MS || 120_000,
);
const resultReadyTimeout = Number(
  process.env.PORTAL_AVAILITY_ELIGIBILITY_RESULT_READY_TIMEOUT_MS || 60_000,
);

type PortalScope = Page | Frame;

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const wanted = new Set(aliases.map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, "")));
  const match = Object.entries(row).find(([key]) => wanted.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")));
  return normalize(match?.[1]);
}

async function enterText(locator: Locator, value: string): Promise<void> {
  try {
    await locator.click({ timeout: 5_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/intercepts pointer events/i.test(message)) throw error;
    await locator.focus();
  }
  await locator.fill("");
  await locator.pressSequentially(value, { delay: 80 });
  await pause(350);
}

async function chooseAutocompleteInput(page: PortalScope, input: Locator, value: string): Promise<void> {
  await input.waitFor({ state: "visible" });
  await enterText(input, value);
  await page.getByRole("option", { name: new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") }).first().click({ timeout: 10_000 })
    .catch(async () => { await input.press("ArrowDown"); await input.press("Enter"); });
  await pause(500);
}

async function chooseAutocomplete(page: PortalScope, selector: string, value: string): Promise<void> {
  await chooseAutocompleteInput(page, page.locator(selector).first(), value);
}

async function providerSelectionIsPresent(
  page: PortalScope,
  providerName: string,
): Promise<boolean> {
  const provider = page.locator(SELECTORS.payerSelection.provider).first();
  if (!await provider.isVisible().catch(() => false)) return false;
  const selectedText = [
    await provider.inputValue().catch(() => ""),
    await provider.getAttribute("value").catch(() => ""),
    await provider.getAttribute("aria-valuetext").catch(() => ""),
    await provider.locator("xpath=..").innerText().catch(() => ""),
  ].join(" ").toLowerCase();
  return providerName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .every((part) => selectedText.includes(part));
}

async function ensureProviderSelected(
  page: PortalScope,
  providerName: string,
): Promise<void> {
  if (await providerSelectionIsPresent(page, providerName)) return;
  await chooseAutocomplete(page, SELECTORS.payerSelection.provider, providerName);
  if (!await providerSelectionIsPresent(page, providerName)) {
    throw new Error(`Provider selection did not retain "${providerName}".`);
  }
}

async function chooseProviderType(page: PortalScope, value: string): Promise<void> {
  const labeledControl = page.getByLabel("Provider Type", { exact: true }).first();
  let input = labeledControl.locator("input[role='combobox'], input").first();
  if (!await input.isVisible().catch(() => false)) {
    const label = page.getByText("Provider Type", { exact: true }).first();
    let container = label.locator("xpath=..");
    for (let depth = 0; depth < 4; depth += 1) {
      const candidate = container.locator("input[role='combobox']").first();
      if (await candidate.isVisible().catch(() => false)) {
        input = candidate;
        break;
      }
      container = container.locator("xpath=..");
    }
  }
  if (!await input.isVisible().catch(() => false)) {
    throw new Error("Provider Type dropdown was not found. Organization was left unchanged.");
  }
  await chooseAutocompleteInput(page, input, value);
}

async function clickFirstVisible(scope: PortalScope, selector: string): Promise<boolean> {
  const candidates = scope.locator(selector);
  const visible: Array<{ locator: Locator; y: number }> = [];
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!await candidate.isVisible().catch(() => false)) continue;
    const box = await candidate.boundingBox().catch(() => null);
    visible.push({ locator: candidate, y: box?.y ?? Number.MAX_SAFE_INTEGER });
  }
  visible.sort((left, right) => left.y - right.y);
  const candidate = visible[0]?.locator;
  if (!candidate) return false;
  await candidate.scrollIntoViewIfNeeded().catch(() => {});
  await candidate.click({ timeout: 10_000 });
  return true;
}
function currentAvailityScopes(rootPage: Page): PortalScope[] {
  const pages = rootPage.context().pages().filter((candidate) => !candidate.isClosed());
  return pages.flatMap((candidate) => [candidate, ...candidate.frames().filter((frame) => frame !== candidate.mainFrame())]);
}

async function findVisibleScope(rootPage: Page, selector: string, timeout: number): Promise<PortalScope | null> {
  const deadline = Date.now() + timeout;
  do {
    for (const scope of currentAvailityScopes(rootPage)) {
      if (await scope.locator(selector).first().isVisible().catch(() => false)) return scope;
    }
    await pause(300);
  } while (Date.now() < deadline);
  return null;
}

async function openInquiry(rootPage: Page, attempt = 1): Promise<PortalScope> {
  const existingForm = await findVisibleScope(rootPage, SELECTORS.payerSelection.payer, 3_000);
  if (existingForm) return existingForm;

  const existingNewRequest = await findVisibleScope(rootPage, SELECTORS.results.newRequest, 3_000);
  if (existingNewRequest && await clickFirstVisible(existingNewRequest, SELECTORS.results.newRequest)) {
    const reopenedForm = await findVisibleScope(rootPage, SELECTORS.payerSelection.payer, 60_000);
    if (reopenedForm) return reopenedForm;
  }

  const patientScope = await findVisibleScope(
    rootPage,
    SELECTORS.navigation.patientRegistration,
    navigationReadyTimeout,
  );
  if (!patientScope) {
    const locations = currentAvailityScopes(rootPage).map((candidate) => candidate.url()).join(" | ");
    throw new Error(`Patient Registration was not found in the Availity top navigation in any open page or iframe. Inspected: ${locations || rootPage.url()}.`);
  }
  if (!await clickFirstVisible(patientScope, SELECTORS.navigation.patientRegistration)) {
    throw new Error("Patient Registration was visible in the Availity top navigation but could not be clicked.");
  }

  const inquiryScope = await findVisibleScope(rootPage, SELECTORS.navigation.eligibilityInquiry, 20_000);
  if (!inquiryScope) {
    throw new Error("Patient Registration was clicked, but Eligibility and Benefits Inquiry did not become visible in any page or iframe.");
  }
  if (!await clickFirstVisible(inquiryScope, SELECTORS.navigation.eligibilityInquiry)) {
    throw new Error("Eligibility and Benefits Inquiry was visible in the Patient Registration dropdown but could not be clicked.");
  }

  const formScope = await findVisibleScope(rootPage, SELECTORS.payerSelection.payer, 60_000);
  if (formScope) return formScope;

  if (attempt < 3) {
    const launcherPages = rootPage.context().pages().filter(
      (page) => !page.isClosed() && /loadApp|web\/eligibility/i.test(page.url()),
    );
    await Promise.all(launcherPages.map(async (page) => {
      await page.reload({ waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    }));
    const reloadedForm = await findVisibleScope(rootPage, SELECTORS.payerSelection.payer, 60_000);
    if (reloadedForm) return reloadedForm;
    await pause(2_000);
    return openInquiry(rootPage, attempt + 1);
  }

  const locations = currentAvailityScopes(rootPage).map((candidate) => candidate.url()).join(" | ");
  throw new Error(
    `Eligibility and Benefits Inquiry did not finish opening after 3 attempts. Inspected: ${locations || rootPage.url()}.`,
  );
}
export function normalizeAvailityDob(value: string): { month: string; day: string; year: string; formatted: string } {
  const text = value.trim();
  let month = 0;
  let day = 0;
  let year = 0;
  let match = text.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2}|\d{4})$/);
  if (match) {
    month = Number(match[1]);
    day = Number(match[2]);
    year = Number(match[3]);
    if (match[3].length === 2) {
      const currentTwoDigitYear = new Date().getFullYear() % 100;
      year += year <= currentTwoDigitYear ? 2000 : 1900;
    }
  } else {
    match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (match) {
      year = Number(match[1]);
      month = Number(match[2]);
      day = Number(match[3]);
    } else {
      const monthNames = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
      match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
      if (match) {
        const normalizedMonth = match[1].toLowerCase();
        month = monthNames.findIndex((name) => name === normalizedMonth || name.startsWith(normalizedMonth)) + 1;
        day = Number(match[2]);
        year = Number(match[3]);
    if (match[3].length === 2) {
      const currentTwoDigitYear = new Date().getFullYear() % 100;
      year += year <= currentTwoDigitYear ? 2000 : 1900;
    }
      }
    }
  }
  const candidate = new Date(year, month - 1, day);
  if (
    !month || !day || year < 1900
    || candidate.getFullYear() !== year
    || candidate.getMonth() !== month - 1
    || candidate.getDate() !== day
  ) {
    throw new Error(`Invalid DOB "${value}". Use MM/DD/YY, MM/DD/YYYY, YYYY-MM-DD, or a month-name date.`);
  }
  const monthText = String(month).padStart(2, "0");
  const dayText = String(day).padStart(2, "0");
  const yearText = String(year);
  return { month: monthText, day: dayText, year: yearText, formatted: `${monthText}/${dayText}/${yearText}` };
}

async function findDobPickerContainer(page: PortalScope): Promise<Locator> {
  // The "As of Date" field under Service Information uses the exact same
  // MUI date-picker component, so its Month/Day/Year spans carry the same
  // aria-label="Month"/"Day"/"Year" as the DOB widget. A page-wide search for
  // those attributes can silently grab the wrong widget. Scoping to the
  // container nearest the "Date of Birth" label avoids that collision.
  const label = page.getByText("Date of Birth", { exact: false }).first();
  await label.waitFor({ state: "visible", timeout: 15_000 });
  let container = label.locator("xpath=..");
  for (let depth = 0; depth < 5; depth += 1) {
    const picker = container.locator("[role='spinbutton']").first();
    if (await picker.isVisible().catch(() => false)) return container;
    container = container.locator("xpath=..");
  }
  throw new Error("Date of Birth date-picker widget was not found near its label.");
}

async function enterDob(page: PortalScope, value: string): Promise<void> {
  const dob = normalizeAvailityDob(value);
  const dobContainer = await findDobPickerContainer(page);

  const monthField = dobContainer.locator("[role='spinbutton'][aria-label='Month']").first();
  const dayField = dobContainer.locator("[role='spinbutton'][aria-label='Day']").first();
  const yearField = dobContainer.locator("[role='spinbutton'][aria-label='Year']").first();

  await monthField.waitFor({ state: "visible", timeout: 15_000 });

  const fillSpinbutton = async (field: Locator, digits: string) => {
    await field.click();
    await field.pressSequentially(digits, { delay: 120 });
    await pause(200);
  };

  await fillSpinbutton(monthField, dob.month);
  await fillSpinbutton(dayField, dob.day);
  await fillSpinbutton(yearField, dob.year);

  // These spans expose no aria-valuenow at all â€” only aria-valuetext, and
  // the visible text content itself (e.g. "03" instead of the "MM"
  // placeholder) is the most reliable signal the value actually landed.
  const readSpinValue = async (field: Locator): Promise<string> => {
    const text = (await field.innerText().catch(() => "")).trim();
    if (text) return text;
    return (await field.getAttribute("aria-valuetext")) || "";
  };

  const actualMonth = await readSpinValue(monthField);
  const actualDay = await readSpinValue(dayField);
  const actualYear = await readSpinValue(yearField);

  const monthOk = actualMonth === dob.month || actualMonth === String(Number(dob.month));
  const dayOk = actualDay === dob.day || actualDay === String(Number(dob.day));
  const yearOk = actualYear === dob.year;

  if (!monthOk || !dayOk || !yearOk) {
    throw new Error(
      `Patient Date of Birth did not retain ${dob.formatted}; found ${actualMonth || "blank"}/${actualDay || "blank"}/${actualYear || "blank"}.`,
    );
  }
}
// Playwright's locator.waitFor rejects on timeout by default. Optional result
// sections (rule 13: "leave blank, don't fail the whole claim") need a
// version that resolves to false instead, so a missing section never crashes
// the run â€” it just means that output column stays blank.
async function tryWaitVisible(locator: Locator, timeout: number): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function readCoverageStatus(page: PortalScope): Promise<"active" | "inactive" | ""> {
  const label = page.locator(SELECTORS.results.memberStatusLabel).filter({ hasText: /^Member Status$/ }).first();
  if (!await tryWaitVisible(label, 1_500)) return "";
  let container = label.locator("xpath=..");
  for (let depth = 0; depth < 3; depth += 1) {
    const text = await container.innerText().catch(() => "");
    if (/\binactive\b/i.test(text)) return "inactive";
    if (/\bactive\b/i.test(text)) return "active";
    container = container.locator("xpath=..");
  }
  return "";
}
async function readPlanDates(page: PortalScope): Promise<{ effectiveDate: string; endDate: string }> {
  const blank = { effectiveDate: "", endDate: "" };
  const label = page.locator(SELECTORS.results.currentPlanEffectiveDateLabel).first();
  if (!await tryWaitVisible(label, 750)) return blank;
  let container = label.locator("xpath=..");
  for (let depth = 0; depth < 3; depth += 1) {
    const text = await container.innerText().catch(() => "");
    const range = text.match(
      /([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s*-\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/,
    );
    if (range) return { effectiveDate: range[1], endDate: range[2] };
    container = container.locator("xpath=..");
  }
  return blank;
}
async function readOtherInsurance(page: PortalScope): Promise<{
  otherInsurance: string;
  otherInsuranceEffectiveDate: string;
}> {
  const blank = { otherInsurance: "", otherInsuranceEffectiveDate: "" };
  const heading = page.locator(SELECTORS.results.additionalPayerHeading).first();
  if (!await tryWaitVisible(heading, 750)) return blank;
  let container = heading.locator("xpath=..");
  for (let depth = 0; depth < 4; depth += 1) {
    const text = await container.innerText().catch(() => "");
    if (/no additional payer information provided/i.test(text)) return blank;
    const payer = text.match(/^Payer:\s*(.+)$/im)?.[1]?.trim();
    const eligibility = text.match(
      /^Eligibility Date:\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})(?:\s*-\s*[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})?$/im,
    )?.[1]?.trim();
    if (payer) {
      return {
        otherInsurance: payer,
        otherInsuranceEffectiveDate: eligibility || "",
      };
    }
    container = container.locator("xpath=..");
  }
  return blank;
}
async function readRelationshipToSubscriber(page: PortalScope): Promise<string> {
  const label = page.locator(SELECTORS.results.relationshipToSubscriberLabel).first();
  if (!await tryWaitVisible(label, 750)) return "";
  let container = label.locator("xpath=..");
  for (let depth = 0; depth < 3; depth += 1) {
    const lines = (await container.innerText().catch(() => ""))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const labelIndex = lines.findIndex((line) => /^Relationship to Subscriber$/i.test(line));
    if (labelIndex >= 0 && lines[labelIndex + 1]) return lines[labelIndex + 1];
    container = container.locator("xpath=..");
  }
  return "";
}
async function readLabeledResultValue(page: PortalScope, selector: string, labelText: string): Promise<string> {
  const label = page.locator(selector).first();
  if (!await tryWaitVisible(label, 750)) return "";
  const escapedLabel = labelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const valuePattern = new RegExp(`${escapedLabel}\\s*:?\\s*(.+)$`, "im");
  let container = label;
  for (let depth = 0; depth < 4; depth += 1) {
    const text = await container.innerText().catch(() => "");
    const value = text.match(valuePattern)?.[1]?.trim();
    if (value && !value.toLowerCase().startsWith(labelText.toLowerCase())) return value;
    container = container.locator("xpath=..");
  }
  return "";
}
async function readSelectedNetwork(page: PortalScope): Promise<string> {
  const label = page.locator(SELECTORS.results.filterByNetworkLabel).first();
  if (!await tryWaitVisible(label, 750)) return "";
  let container = label.locator("xpath=..");
  for (let depth = 0; depth < 4; depth += 1) {
    const controls = container.locator("button, [role='button'], [role='option']");
    const count = await controls.count();
    if (count > 0) {
      let fallback = "";
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (!await control.isVisible().catch(() => false)) continue;
        const text = (await control.innerText().catch(() => "")).trim();
        if (!text || /^filter by network$/i.test(text)) continue;
        fallback ||= text;
        const selected = await control.evaluate((element) => {
          const state = `${element.getAttribute("aria-pressed") || ""} ${element.getAttribute("aria-selected") || ""}`;
          return /true/i.test(state) || /(?:^|\s)(?:active|selected|Mui-selected|containedPrimary)(?:\s|$)/i.test(element.className || "");
        }).catch(() => false);
        if (selected) return /^all networks?$/i.test(text) ? "" : text;
      }
      if (fallback) return /^all networks?$/i.test(fallback) ? "" : fallback;
    }
    container = container.locator("xpath=..");
  }
  return "";
}
type BenefitValues = {
  coinsurance: string;
  copay: string;
  deductible: string;
  deductibleMet: string;
  outOfPocket: string;
  outOfPocketMet: string;
};

function moneyBeforeCalendarYear(text: string): string {
  return text.match(/(\$[\d,]+(?:\.\d{1,2})?)\s*\/\s*(?:Calendar|Service)\s+Year(?:\(s\)|s)?/i)?.[1] || "";
}

function yearToDateMoney(text: string): string {
  return text.match(/-?\s*(\$[\d,]+(?:\.[\d]{1,2})?)\s*Year\s+to\s+Date/i)?.[1] || "";
}

function sectionBetween(text: string, start: RegExp, end?: RegExp): string {
  const startMatch = start.exec(text);
  if (!startMatch?.index && startMatch?.index !== 0) return "";
  const content = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = end?.exec(content);
  return endMatch?.index === undefined ? content : content.slice(0, endMatch.index);
}

function benefitRow(section: string, start: RegExp, end?: RegExp): string {
  return sectionBetween(section, start, end);
}

// Splits a section into chunks anchored on each "Coverage Level:" marker and
// keeps only the ones tagged Individual (rule 8: ignore Family everywhere).
// Some portal layouts (e.g. a POS Deductible/OOP box) tag Coverage Level once
// per benefit box; others (e.g. a PPO Plan Maximums table) tag it once for
// the whole table. Either way, filtering here means we never accidentally
// read a Family row.
function individualChunks(section: string): string[] {
  return section
    .split(/(?=Coverage\s*Level\s*:\s*)/i)
    .filter((chunk) => /^Coverage\s*Level\s*:\s*Individual\b/i.test(chunk.trim()));
}

// Portal shows "â€”" for benefits it has no data for (rule 11/13: leave blank).
function individualBenefitBlock(text: string, heading: RegExp): string {
  const section = sectionBetween(text, heading);
  return sectionBetween(
    section,
    /Coverage\s*Level\s*:\s*Individual/i,
    /Coverage\s*Level\s*:\s*Family|Professional\s*\(Physician\)\s*Visit|Health Benefit Plan Coverage/i,
  );
}
function cleanValue(value: string): string {
  return value === "â€”" || value === "-" ? "" : value;
}

export function parseAvailityBcbsBenefits(resultText: string, memberId: string): BenefitValues {
  const isRMember = /^R/i.test(memberId.trim());

  const health = sectionBetween(
    resultText,
    /Health Benefit Plan Coverage\s*-\s*30/i,
    /Professional\s*\(Physician\)\s*Visit\s*-\s*Office\s*-\s*98/i,
  );
  const healthChunks = individualChunks(health);
  const healthIndividualAll = healthChunks.length ? healthChunks.join("\n") : health;

  // Deductible (rule 12): use the Individual Calendar Year/Remaining amounts
  // regardless of network â€” no network filtering here on purpose.
  const deductibleRow = benefitRow(healthIndividualAll, /Annual\s+Deductible/i, /Out\s+Of\s+Pocket/i);

  // Out of Pocket (rule 12): for R-prefixed member IDs, prefer the row from
  // a "Preferred" network chunk if one exists; otherwise use all Individual
  // Out of Pocket data combined.
  let outOfPocketSource = healthIndividualAll;
  if (isRMember) {
    const preferredChunk = healthChunks.find(
      (chunk) => /preferred/i.test(chunk) && /out\s+of\s+pocket/i.test(chunk),
    );
    if (preferredChunk) outOfPocketSource = preferredChunk;
  }
  let outOfPocketRow = benefitRow(outOfPocketSource, /Out\s+Of\s+Pocket/i);
  if (!moneyBeforeCalendarYear(outOfPocketRow)) {
    outOfPocketRow = individualBenefitBlock(resultText, /Out\s+Of\s+Pocket/i);
  }

  const professional = sectionBetween(
    resultText,
    /Professional\s*\(Physician\)\s*Visit\s*-\s*Office\s*-\s*98/i,
  );
  // Professional coinsurance/copay must come only from the Professional
  // Physician section. Health-plan percentages (for example an OOP progress
  // value such as 17%) are never valid professional coinsurance.
  const individualBlocks = individualChunks(professional);
  const coinsurancePattern = /(?:^|[^\d])((?:100(?:\.0+)?|(?:\d|[1-9]\d)(?:\.\d+)?))\s*%/i;
  const copayPattern = /(\$[\d,]+(?:\.\d{1,2})?)\s*(?:\/|per)?\s*(?:Visit|Day)(?:\s*\(s\)|s)?/i;
  // The Professional section may provide coinsurance without a copay (the
  // portal displays a dash), or copay without coinsurance. Either value makes
  // the Individual professional row eligible for selection.
  const hasProfessionalValue = (block: string): boolean =>
    coinsurancePattern.test(block) || copayPattern.test(block);

  // If multiple Individual professional rows are present, select Specialist;
  // R-prefixed members prioritize Preferred Specialist. If Specialist is not
  // present, use the first Individual professional row containing benefits.
  let professionalBenefit = "";
  if (isRMember) {
    professionalBenefit = individualBlocks.find(
      (block) => /preferred\s*specialist/i.test(block) && hasProfessionalValue(block),
    ) || "";
  }
  if (!professionalBenefit) {
    professionalBenefit = individualBlocks.find(
      (block) => /specialist\b/i.test(block) && hasProfessionalValue(block),
    ) || "";
  }

  if (!professionalBenefit) {
    professionalBenefit = individualBlocks.find(hasProfessionalValue) || "";
  }

  const coinsuranceMatch = professionalBenefit.match(coinsurancePattern);
  const copayMatch = professionalBenefit.match(copayPattern);

  return {
    coinsurance: cleanValue(coinsuranceMatch ? `${coinsuranceMatch[1]}%` : ""),
    copay: cleanValue(copayMatch?.[1] || ""),
    deductible: cleanValue(moneyBeforeCalendarYear(deductibleRow)),
    deductibleMet: cleanValue(yearToDateMoney(deductibleRow)),
    outOfPocket: cleanValue(moneyBeforeCalendarYear(outOfPocketRow)),
    outOfPocketMet: cleanValue(yearToDateMoney(outOfPocketRow)),
  };
}

async function readProfessionalTableBenefits(
  scope: PortalScope,
  memberId: string,
): Promise<Pick<BenefitValues, "coinsurance" | "copay"> | null> {
  const rows = await scope.evaluate(() => {
    const normalize = (value: string | null | undefined) =>
      (value || "").replace(/\s+/g, " ").trim();
    const professionalHeading = /Professional\s*\(Physician\)\s*Visit\s*-\s*Office\s*-\s*98/i;
    const allElements = Array.from(document.querySelectorAll<HTMLElement>("body *"));
    const headings = allElements.filter((element) => {
      const text = normalize(element.textContent);
      if (!professionalHeading.test(text)) return false;
      return !Array.from(element.children).some((child) =>
        professionalHeading.test(normalize(child.textContent))
      );
    });

    let section: HTMLElement | null = null;
    for (const heading of headings) {
      let candidate: HTMLElement | null = heading;
      for (let depth = 0; candidate && depth < 8; depth += 1, candidate = candidate.parentElement) {
        const table = candidate.querySelector("table");
        const headerText = normalize(table?.querySelector("thead")?.textContent || table?.textContent);
        if (/Co\s*-?\s*Insurance/i.test(headerText) && /Co\s*-?\s*Payment/i.test(headerText)) {
          if (!section || normalize(candidate.textContent).length < normalize(section.textContent).length) {
            section = candidate;
          }
          break;
        }
      }
    }

    if (!section) return [] as Array<{ text: string; coinsurance: string; copay: string }>;

    const extracted: Array<{ text: string; coinsurance: string; copay: string }> = [];
    for (const table of Array.from(section.querySelectorAll("table"))) {
      const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>("thead th, th"));
      const coinsuranceHeader = headers.find((header) =>
        /^Co\s*-?\s*Insurance$/i.test(normalize(header.textContent))
      );
      const copayHeader = headers.find((header) =>
        /^Co\s*-?\s*Payment$/i.test(normalize(header.textContent))
      );
      if (!coinsuranceHeader || !copayHeader) continue;

      const coinsuranceIndex = coinsuranceHeader.cellIndex;
      const copayIndex = copayHeader.cellIndex;
      for (const row of Array.from(table.querySelectorAll<HTMLTableRowElement>("tbody tr"))) {
        const cells = Array.from(row.cells);
        extracted.push({
          text: normalize(row.textContent),
          coinsurance: normalize(cells[coinsuranceIndex]?.textContent),
          copay: normalize(cells[copayIndex]?.textContent),
        });
      }
    }
    return extracted;
  }).catch(() => [] as Array<{ text: string; coinsurance: string; copay: string }>);

  const individual = rows.filter((row) =>
    /Coverage\s*Level\s*:?\s*Individual/i.test(row.text)
  );
  if (!individual.length) return null;

  const isRMember = /^R/i.test(memberId.trim());
  const selected = (
    isRMember
      ? individual.find((row) => /preferred\s*specialist/i.test(row.text))
      : undefined
  ) || individual.find((row) => /specialist/i.test(row.text)) || individual[0];

  const coinsurance = selected.coinsurance.match(
    /(?:^|[^\d])((?:100(?:\.0+)?|(?:\d|[1-9]\d)(?:\.\d+)?))\s*%/i,
  )?.[1];
  const copay = selected.copay.match(/(\$[\d,]+(?:\.\d{1,2})?)/)?.[1];
  return {
    coinsurance: coinsurance ? `${coinsurance}%` : "",
    copay: copay || "",
  };
}
async function readPrimaryCareProvider(page: PortalScope): Promise<string> {
  const heading = page.getByText("Primary Care Provider", { exact: true }).first();
  if (!await heading.isVisible().catch(() => false)) return "";
  let container = heading.locator("xpath=..");
  for (let depth = 0; depth < 4; depth += 1) {
    const lines = (await container.innerText().catch(() => ""))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const index = lines.findIndex((line) => /^Primary Care Provider$/i.test(line));
    const value = lines.slice(index + 1).find((line) => !/^(?:Name|NPI|Address|Phone)\s*:?$/i.test(line));
    if (index >= 0 && value) return value.replace(/^Name\s*:\s*/i, "").trim();
    container = container.locator("xpath=..");
  }
  return "";
}
type SnapshotBasics = {
  coverageStatus: string;
  effectiveDate: string;
  endDate: string;
  relationship: string;
  insuranceType: string;
  planType: string;
};

export function extractAvailityPortalError(text: string): string {
  const submissionError = text.match(
    /Submission\s+Error\s+([\s\S]*?Blue\s+Cross\s+Medicare\s+Advantage\.?)/i,
  );
  if (submissionError) {
    return `Submission Error: ${submissionError[1].replace(/\s+/g, " ").trim()}`;
  }

  const connectionProblem = text.match(
    /Availity\s+is\s+experiencing\s+connection\s+problems\s+with\s+the\s+health\s+plan[\s\S]*?(?=Date\s+of\s+Service|$)/i,
  )?.[0]?.replace(/\s+/g, " ").trim();
  if (!connectionProblem) return "";

  const transactionId = text.match(/Transaction\s*ID\s*:?\s*([A-Za-z0-9-]+)/i)?.[1];
  const transactionTime = text.match(
    /Transaction\s*Time\s*:?\s*([^\r\n]+?)(?=\s+Customer\s*ID|$)/i,
  )?.[1]?.trim();
  const details = [
    transactionId ? `Transaction ID: ${transactionId}` : "",
    transactionTime ? `Transaction Time: ${transactionTime}` : "",
  ].filter(Boolean).join("; ");
  return details ? `${connectionProblem} (${details})` : connectionProblem;
}
export function hasUsableEligibilityResult(text: string): boolean {
  return /Member\s*Status\s*:?\s*(?:Active|Inactive)\b|(?:Active|Inactive)\s+Coverage\b/i.test(text);
}

async function revealEligibilityBenefits(scope: PortalScope): Promise<void> {
  await scope.evaluate(() => {
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("[aria-expanded='false']"))) {
      if (/Health\s*Benefit\s*Plan\s*Coverage|Professional\s*\(Physician\)\s*Visit/i.test(element.innerText || "")) {
        element.click();
      }
    }
    const scrollingElement = document.scrollingElement;
    if (scrollingElement) scrollingElement.scrollTop = scrollingElement.scrollHeight;
  }).catch(() => {});
}

async function readStableResultText(scope: PortalScope, timeout = resultReadyTimeout): Promise<string> {
  const body = scope.locator("body");
  const deadline = Date.now() + timeout;
  let previous = "";
  let latest = "";
  let stableReadyReads = 0;
  let attempts = 0;
  do {
    attempts += 1;
    if (attempts === 1 || attempts % 4 === 0) await revealEligibilityBenefits(scope);
    const visible = await body.innerText({ timeout: 1_500 }).catch(() => "");
    const complete = await body.textContent({ timeout: 1_500 }).catch(() => "");
    const current = `${visible}\n${complete || ""}`;
    const portalError = extractAvailityPortalError(current);
    if (portalError) return current;
    const ready = hasUsableEligibilityResult(current);

    if (ready && current === previous) stableReadyReads += 1;
    else stableReadyReads = 0;
    if (current) latest = current;
    previous = current;
    if (stableReadyReads >= 2) return current;
    await pause(500);
  } while (Date.now() < deadline);
  return latest;
}

export function parseAvailitySnapshotBasics(text: string): SnapshotBasics {
  const date = "([A-Za-z]{3,9}\\s+\\d{1,2},\\s*\\d{4})";
  const planRange = text.match(new RegExp(`Current\\s*Plan\\s*Effective\\s*Date\\s*:?\\s*${date}\\s*-\\s*${date}`, "i"));
  const eligibilityStart = text.match(new RegExp(`Eligibility\\s*Start\\s*Date\\s*:?\\s*${date}`, "i"));
  const eligibilityEnd = text.match(new RegExp(`Eligibility\\s*End\\s*Date\\s*:?\\s*${date}`, "i"));
  const coverage = text.match(/Member\s*Status\s*:?\s*(Active|Inactive)\b/i)?.[1]
    || text.match(/\b(Active|Inactive)\s+Coverage\b/i)?.[1]
    || "";
  const relationship = text.match(
    /Relationship\s*to\s*Subscriber\s*:?\s*(Self|Spouse|Child|Dependent|Employee|Other)\b/i,
  )?.[1] || "";
  const insuranceType = text.match(/^\s*Insurance\s*Type\s*:\s*(.+)$/im)?.[1]?.trim() || "";
  const planType = text.match(/^\s*Plan\s*\/\s*Product\s*:\s*(.+)$/im)?.[1]?.trim() || "";
  return {
    coverageStatus: coverage,
    effectiveDate: planRange?.[1] || eligibilityStart?.[1] || "",
    endDate: planRange?.[2] || eligibilityEnd?.[1] || "",
    relationship,
    insuranceType,
    planType,
  };
}
async function findResultScope(rootPage: Page, timeout: number): Promise<PortalScope | null> {
  const markers = [
    SELECTORS.results.newRequest,
    SELECTORS.results.memberStatusLabel,
    SELECTORS.results.currentPlanEffectiveDateLabel,
    SELECTORS.results.additionalPayerHeading,
    SELECTORS.results.relationshipToSubscriberLabel,
    SELECTORS.results.filterByNetworkLabel,
  ];
  const deadline = Date.now() + timeout;
  do {
    for (const scope of currentAvailityScopes(rootPage)) {
      for (const marker of markers) {
        if (await scope.locator(marker).first().isVisible().catch(() => false)) return scope;
      }
    }
    await pause(300);
  } while (Date.now() < deadline);
  return null;
}

async function openNextRequest(rootPage: Page): Promise<PortalScope> {
  const resultScope = await findResultScope(rootPage, 20_000);
  if (!resultScope || !await clickFirstVisible(resultScope, SELECTORS.results.newRequest)) {
    throw new Error("New Request was not available after the previous eligibility response.");
  }
  const formScope = await findVisibleScope(rootPage, SELECTORS.payerSelection.payer, 30_000);
  if (!formScope) throw new Error("New Request was clicked, but the payer field did not reopen.");
  return formScope;
}

function blankOutput(): Record<string, string> {
  return Object.fromEntries([
    "Coverage Status", "Eff Date", "End Date", "Other Ins", "Other Ins Eff Date",
    "Relationship to Subscriber", "Plan Type", "Bot Insurance Type", "Network",
    "Coinsurance", "Copay", "Deductible", "Deductible Met", "Out of Pocket", "Out of Pocket Met", "Error",
  ].map((header) => [header, ""]));
}

async function emitRowScreenshot(context: AvailityEligibilityPayerWorkflowInput["context"], page: Page, rowIndex: number): Promise<void> {
  const screenshot = await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  if (screenshot) await context.emit({ type: "error_screenshot", index: rowIndex, image: screenshot.toString("base64") }).catch(() => {});
}

export async function runBcbsAvailityEligibilityWorkflow({ page, inputFile, context }: AvailityEligibilityPayerWorkflowInput): Promise<void> {
  const workbook = XLSX.read(await inputFile.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The BCBS eligibility workbook does not contain a worksheet.");
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false });
  if (!rows.length) throw new Error("The BCBS eligibility workbook is empty.");

  await context.emit({ type: "progress", completed: 0, total: rows.length });
  await context.log({ level: "info", message: `Starting ${rows.length} Availity BCBS row(s).`, eventName: "eligibility_availity_batch_started" });
  await context.log({ level: "info", message: "Opening Patient Registration and Eligibility and Benefits Inquiry.", eventName: "eligibility_availity_navigation_started" });
  let portal = await openInquiry(page);
  await context.log({ level: "info", message: "Eligibility and Benefits Inquiry opened successfully.", eventName: "eligibility_availity_navigation_complete" });

  const outputRows: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let previousFailed = false;

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const excelRow = index + 2;
    try {
      if (index > 0) portal = previousFailed ? await openInquiry(page) : await openNextRequest(page);
      const memberId = findValue(row, ["Primary Ins Subscriber No", "Member ID", "Patient ID", "Subscriber ID", "Subscriber No"]);
      const dob = findValue(row, ["DOB", "Date of Birth", "Patient DOB", "Patient Birthdate", "Pat Birthdate", "Birthdate"]);
      if (!memberId || !dob) throw new Error("Missing Member ID/Patient ID or DOB.");

      await context.log({ level: "info", message: `Row ${excelRow}: entering patient eligibility data.`, eventName: "eligibility_availity_row_started", rowIndex: excelRow });
      await chooseAutocomplete(portal, SELECTORS.payerSelection.payer, findValue(row, ["Payer Portal", "Payer Code"]) || "BCBSTX");
      await ensureProviderSelected(portal, "DAO, THUAN DUC");
      await chooseProviderType(portal, findValue(row, ["Provider Type"]) || "Professional");
      await enterText(portal.locator(SELECTORS.inquiryForm.memberId).first(), memberId);
      await enterDob(portal, dob);
      for (const tip of await portal.locator(SELECTORS.inquiryForm.dismissTips).all()) await tip.click().catch(() => {});
      await chooseAutocomplete(portal, SELECTORS.inquiryForm.placeOfService, findValue(row, ["Place of Service"]) || "Office");
      await chooseAutocomplete(portal, SELECTORS.inquiryForm.serviceType, findValue(row, ["Benefit Service Type", "Service Type"]) || "Health Benefit Plan Coverage - 30");

      const submit = portal.locator(SELECTORS.inquiryForm.submit).first();
      await submit.waitFor({ state: "visible" });
      if (await submit.isDisabled()) throw new Error("The inquiry is incomplete and Submit is disabled.");
      await pause(700);
      await submit.click();

      const resultScope = await findResultScope(page, 60_000);
      if (!resultScope) throw new Error("No eligibility result appeared in any open page or iframe after Submit.");
      portal = resultScope;
      await context.log({ level: "info", message: `Row ${excelRow}: response opened; extracting available fields.`, eventName: "eligibility_availity_result_opened", rowIndex: excelRow });


      const resultText = await readStableResultText(portal);
      const portalError = extractAvailityPortalError(resultText);
      if (portalError) {
        throw new Error(`${portalError} Skipping this claim.`);
      }
      if (!hasUsableEligibilityResult(resultText)) {
        throw new Error(`The Availity response did not finish loading an Active or Inactive Member Status within ${Math.round(resultReadyTimeout / 1000)} seconds.`);
      }
      const snapshot = parseAvailitySnapshotBasics(resultText);
      const locatedCoverageStatus = await readCoverageStatus(portal);
      const locatedDates = await readPlanDates(portal);
      let { otherInsurance, otherInsuranceEffectiveDate } = await readOtherInsurance(portal);
      const relationship = await readRelationshipToSubscriber(portal) || snapshot.relationship;
      const insuranceType = await readLabeledResultValue(portal, SELECTORS.results.insuranceTypeLabel, "Insurance Type") || snapshot.insuranceType;
      const planType = await readLabeledResultValue(portal, SELECTORS.results.planProductLabel, "Plan / Product") || snapshot.planType;
      const coverageStatus = locatedCoverageStatus || snapshot.coverageStatus.toLowerCase();
      const effectiveDate = locatedDates.effectiveDate || snapshot.effectiveDate;
      const endDate = locatedDates.endDate || snapshot.endDate;
      const network = await readSelectedNetwork(portal);
      if (/\bhmo\b/i.test(insuranceType) && !otherInsurance) {
        otherInsurance = await readPrimaryCareProvider(portal);
        otherInsuranceEffectiveDate = "";
      }
      const benefits = parseAvailityBcbsBenefits(resultText, memberId);
      const tableBenefits = await readProfessionalTableBenefits(portal, memberId);
      if (tableBenefits?.coinsurance) benefits.coinsurance = tableBenefits.coinsurance;
      if (tableBenefits?.copay) benefits.copay = tableBenefits.copay;

      const result = {
        "Coverage Status": coverageStatus ? coverageStatus[0].toUpperCase() + coverageStatus.slice(1) : "",
        "Eff Date": effectiveDate,
        "End Date": endDate,
        "Other Ins": otherInsurance,
        "Other Ins Eff Date": otherInsuranceEffectiveDate,
        "Relationship to Subscriber": relationship,
        "Plan Type": planType,
        "Bot Insurance Type": insuranceType,
        Network: network,
        Coinsurance: benefits.coinsurance,
        Copay: benefits.copay,
        Deductible: benefits.deductible,
        "Deductible Met": benefits.deductibleMet,
        "Out of Pocket": benefits.outOfPocket,
        "Out of Pocket Met": benefits.outOfPocketMet,
        Error: "",
      };
      outputRows.push({ ...row, ...result });
      await context.emit({ type: "eligibility_availity_result", update: result, rowIndex: excelRow });
      await context.log({
        level: "info",
        message: `Row ${excelRow}: benefits extracted (Coinsurance: ${benefits.coinsurance || "blank"}; Copay: ${benefits.copay || "blank"}; Deductible: ${benefits.deductible || "blank"}; Deductible Met: ${benefits.deductibleMet || "blank"}; Out of Pocket: ${benefits.outOfPocket || "blank"}; Out of Pocket Met: ${benefits.outOfPocketMet || "blank"}).`,
        eventName: "eligibility_availity_row_complete",
        rowIndex: excelRow,
      });
      previousFailed = false;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`Row ${excelRow}: ${message}`);
      outputRows.push({ ...row, ...blankOutput(), Error: message });
      await context.log({ level: "error", message: `Row ${excelRow}: ${message}`, eventName: "eligibility_availity_row_failed", rowIndex: excelRow });
      await emitRowScreenshot(context, page, index);
      previousFailed = true;
    } finally {
      await context.emit({ type: "progress", completed: index + 1, total: rows.length });
    }
  }

  const outputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(outputWorkbook, XLSX.utils.json_to_sheet(outputRows), "Eligibility Output");
  const output = XLSX.write(outputWorkbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  await context.emit({
    type: "file_download",
    filename: "availity-bcbs-eligibility-output.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    base64: output.toString("base64"),
  });

  if (errors.length) {
    const report = ["Availity BCBS eligibility row error report", `Generated: ${new Date().toISOString()}`, `Total rows: ${rows.length}`, `Failed rows: ${errors.length}`, "", ...errors].join("\n");
    await context.emit({ type: "file_download", filename: "availity-eligibility-error-report.txt", mimeType: "text/plain", base64: Buffer.from(report).toString("base64") });
    await context.log({ level: "warn", message: `Completed with ${errors.length} failed row(s); partial output was created.`, eventName: "eligibility_availity_batch_errors" });
  } else {
    await context.log({ level: "info", message: `Completed ${outputRows.length} Availity eligibility row(s).`, eventName: "eligibility_availity_batch_complete" });
  }
}