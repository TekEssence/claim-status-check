import ExcelJS from "exceljs";
import type { Page } from "playwright-core";
import type { AutomationContext } from "../../../../../types";

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
      if (normalizedLine.startsWith(`${alias} `) && /[:–—]/.test(line)) {
        return line.replace(/^[^:–—]+[:–—]\s*/, "").trim();
      }
    }
  }
  return "";
}

export function parseUhcEligibilityResultText(text: string): UhcEligibilityOutput {
  const output = outputTemplate();
  for (const header of UHC_OUTPUT_HEADERS) output[header] = labeledValue(text, LABELS[header]);

  const status = text.match(/\b(?:coverage|member)\s+status\s*[:–—-]?\s*(active|inactive)\b/i)?.[1];
  if (status) output["Coverage Status"] = status[0].toUpperCase() + status.slice(1).toLowerCase();
  return output;
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
  const memberColumn = findColumn(headers, ["Member ID", "Subscriber ID", "Primary Ins Subscriber No", "ID"]);
  const dobColumn = findColumn(headers, ["Date of Birth", "DOB", "Patient DOB", "Birthdate"]);
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
  const member = page.locator(SELECTORS.memberId).first();
  const dob = page.locator(SELECTORS.dateOfBirth).first();
  await member.waitFor({ state: "visible" });
  await member.fill(row.memberId);
  await dob.fill(formatDob(row.dateOfBirth));
  await page.locator(SELECTORS.submit).click();
}

async function waitForResultText(page: Page): Promise<string> {
  await page.locator(SELECTORS.newSearch).waitFor({ state: "visible", timeout: 60_000 });
  let previous = "";
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const current = await page.locator("body").innerText();
    if (current === previous && /coverage|member status|plan type/i.test(current)) return current;
    previous = current;
    await page.waitForTimeout(500);
  }
  return previous;
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
      if (index > 0) {
        await options.page.locator(SELECTORS.newSearch).click();
      }
      await enterSearch(options.page, row);
      result = parseUhcEligibilityResultText(await waitForResultText(options.page));
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
