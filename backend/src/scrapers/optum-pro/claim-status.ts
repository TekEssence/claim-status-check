import type { Page } from "playwright-core";
import type { ScraperContext } from "../types";
import type { OptumProInputRow } from "./input";

type StageLog = (level: "info" | "warn" | "error", stage: string, message: string, currentPage?: Page) => Promise<void>;

type OptumProSearchResult = {
  rowNumber: number;
  groupName: string;
  patient: string;
  dos: string;
  cpt: string;
  memberId: string;
  matchedPatient: string;
  matchedGroup: string;
  resultSummary: string;
  status: string;
  notes: string;
};

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function csvCell(value: string | number): string {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function normalizeDate(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!match) return trimmed;
  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${month}/${day}/${year}`;
}

function downloadableTextFileEvent(filename: string, content: string, mimeType = "text/plain"): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: Buffer.from(content, "utf8").toString("base64"),
    mimeType,
  };
}

async function clickFirstVisible(page: Page, selectors: string[], timeout = 2000): Promise<boolean> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout }).catch(() => false)) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function fillInputLikeUser(page: Page, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: "visible", timeout: 30000 });
  await locator.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await locator.pressSequentially(value, { delay: 60 });
  await page.waitForTimeout(700);
}

async function visibleRows(page: Page): Promise<Array<{ index: number; text: string }>> {
  const rows = page.locator("tbody tr:visible");
  const count = await rows.count().catch(() => 0);
  const values: Array<{ index: number; text: string }> = [];
  for (let index = 0; index < count; index++) {
    const text = await rows.nth(index).innerText({ timeout: 1000 }).catch(() => "");
    if (text.trim()) values.push({ index, text: text.replace(/\s+/g, " ").trim() });
  }
  return values;
}

async function selectPatient(page: Page, row: OptumProInputRow): Promise<string> {
  await fillInputLikeUser(page, "input[placeholder*='Subscriber ID'], input[placeholder*='Patient Name'], input[placeholder*='Date of Birth']", row.memberId);
  await page.waitForTimeout(1200);

  let rows = await visibleRows(page);
  let match = rows.find((candidate) => normalize(candidate.text).includes(normalize(row.memberId)));

  if (!match && row.patient) {
    rows = await visibleRows(page);
    match = rows.find((candidate) => normalize(candidate.text).includes(normalize(row.patient)));
  }

  if (!match) {
    throw new Error(`No patient dropdown match found for Member Id ${row.memberId} / patient ${row.patient}.`);
  }

  await page.locator("tbody tr:visible").nth(match.index).click();
  await page.waitForTimeout(700);
  return match.text;
}

async function selectMedicalGroup(page: Page, groupName: string): Promise<string> {
  await fillInputLikeUser(page, "input[placeholder*='Medical group'], input[placeholder*='Medical Group']", groupName);
  await page.waitForTimeout(1200);

  const options = page.locator("mat-option:visible, [role='option']:visible");
  const count = await options.count().catch(() => 0);
  if (!count) {
    throw new Error(`No medical group options appeared for ${groupName}.`);
  }

  const wanted = normalize(groupName);
  let bestIndex = 0;
  let bestScore = -1;
  let bestText = "";

  for (let index = 0; index < count; index++) {
    const text = (await options.nth(index).innerText({ timeout: 1000 }).catch(() => "")).replace(/\s+/g, " ").trim();
    const candidate = normalize(text);
    const score = candidate === wanted ? 1000 : candidate.includes(wanted) || wanted.includes(candidate) ? 500 : commonPrefixLength(candidate, wanted);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
      bestText = text;
    }
  }

  await options.nth(bestIndex).click();
  await page.waitForTimeout(700);
  return bestText;
}

function commonPrefixLength(a: string, b: string): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length++;
  return length;
}

async function setServiceDate(page: Page, dos: string): Promise<void> {
  const normalizedDos = normalizeDate(dos);
  const dateType = page.locator("select").first();
  if (await dateType.isVisible({ timeout: 1000 }).catch(() => false)) {
    const options = await dateType.locator("option").allTextContents().catch(() => []);
    const serviceDateLabel = options.find((option) => /service date/i.test(option));
    if (serviceDateLabel) {
      await dateType.selectOption({ label: serviceDateLabel }).catch(() => {});
    }
  }

  const dateRangeInput = page.locator("input[placeholder*='MM/DD/YYYY']").first();
  await dateRangeInput.waitFor({ state: "visible", timeout: 30000 });
  await dateRangeInput.click();
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  await dateRangeInput.pressSequentially(`${normalizedDos} - ${normalizedDos}`, { delay: 45 });
  await page.waitForTimeout(500);
}

async function captureResultSummary(page: Page): Promise<string> {
  await page.waitForTimeout(2000);
  const summaryText = await page.locator("text=/Results? Found/i").first().innerText({ timeout: 5000 }).catch(() => "");
  const rows = await visibleRows(page);
  if (!rows.length) return summaryText || "No result rows visible.";
  return [summaryText, rows.map((row) => row.text).join(" | ")].filter(Boolean).join(" - ");
}

async function searchClaimRow(page: Page, row: OptumProInputRow, stageLog: StageLog): Promise<OptumProSearchResult> {
  await stageLog("info", "claim-search", `Processing Optum Pro input row ${row.rowNumber}: member ${row.memberId}, DOS ${row.dos}, group ${row.groupName}.`);

  await clickFirstVisible(page, ["button:has-text('Clear all')"], 1000).catch(() => {});
  const matchedPatient = await selectPatient(page, row);
  const matchedGroup = await selectMedicalGroup(page, row.groupName);
  await setServiceDate(page, row.dos);

  const searchButton = page.locator("button:has-text('Search')").last();
  await searchButton.waitFor({ state: "visible", timeout: 30000 });
  await searchButton.click();
  const resultSummary = await captureResultSummary(page);

  return {
    rowNumber: row.rowNumber,
    groupName: row.groupName,
    patient: row.patient,
    dos: row.dos,
    cpt: row.cpt,
    memberId: row.memberId,
    matchedPatient,
    matchedGroup,
    resultSummary,
    status: /no result/i.test(resultSummary) ? "not_found" : "searched",
    notes: "",
  };
}

async function openClaimsSearch(page: Page, stageLog: StageLog): Promise<void> {
  await stageLog("info", "claim-navigation", "Opening Optum Pro Claims menu.");
  await page.locator("text=/Optum Pro portal|Hello,/i").first().waitFor({ state: "visible", timeout: 60000 }).catch(() => {});
  await page.locator("button:has-text('Claims'), a:has-text('Claims'), [role='button']:has-text('Claims')").first().click();

  const nammOption = page.locator("text=NAMM").first();
  if (await nammOption.isVisible({ timeout: 10000 }).catch(() => false)) {
    await stageLog("info", "claim-navigation", "Selecting NAMM CDO.");
    await nammOption.click();
  }

  await page.locator("text=Claim Search").first().waitFor({ state: "visible", timeout: 60000 });
  await page.locator("input[placeholder*='Subscriber ID'], input[placeholder*='Patient Name']").first().waitFor({ state: "visible", timeout: 60000 });
  await stageLog("info", "claim-navigation", "Optum Pro Claim Search page is ready.");
}

export async function runOptumProClaimSearch(
  page: Page,
  rows: OptumProInputRow[],
  context: ScraperContext,
  stageLog: StageLog,
): Promise<void> {
  await openClaimsSearch(page, stageLog);
  const results: OptumProSearchResult[] = [];
  await context.emit({ type: "progress", completed: 0, total: rows.length });

  for (let index = 0; index < rows.length; index++) {
    if (context.isCancelled?.()) {
      await stageLog("warn", "claim-search", "Optum Pro claim search cancelled.");
      break;
    }

    try {
      results.push(await searchClaimRow(page, rows[index], stageLog));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await stageLog("error", "claim-search", `Row ${rows[index].rowNumber} failed: ${message}`);
      results.push({
        rowNumber: rows[index].rowNumber,
        groupName: rows[index].groupName,
        patient: rows[index].patient,
        dos: rows[index].dos,
        cpt: rows[index].cpt,
        memberId: rows[index].memberId,
        matchedPatient: "",
        matchedGroup: "",
        resultSummary: "",
        status: "error",
        notes: message,
      });
    }

    await context.emit({ type: "progress", completed: index + 1, total: rows.length });
  }

  const csvRows = [
    ["Row", "Group Name", "Patient", "DOS", "CPT", "Member Id", "Matched Patient", "Matched Group", "Status", "Result Summary", "Notes"],
    ...results.map((result) => [
      result.rowNumber,
      result.groupName,
      result.patient,
      result.dos,
      result.cpt,
      result.memberId,
      result.matchedPatient,
      result.matchedGroup,
      result.status,
      result.resultSummary,
      result.notes,
    ]),
  ];
  const csv = csvRows.map((row) => row.map(csvCell).join(",")).join("\n");
  await context.emit(downloadableTextFileEvent("optum-pro-claim-search-results.csv", csv, "text/csv"));
}
