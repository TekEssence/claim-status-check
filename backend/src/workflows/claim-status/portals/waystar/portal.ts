import type { Locator, Page } from "playwright-core";
import { extractTextFromPdf } from "../iehp/claims/pdf";
import { loginToWaystar } from "../../../eligibility-verification/portals/waystar/portal";
import type { WaystarCredentials } from "../../../eligibility-verification/portals/waystar/credentials";
import { WAYSTAR_CLAIM_STATUS_SELECTORS } from "./selectors";
import type { WaystarClaimExtraction, WaystarClaimInputRow, WaystarProcedureLine } from "./types";

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizePayer(value: string): string {
  return normalizeText(value).replace(/[^a-z0-9 ]+/g, " ");
}

function normalizeClaimNumber(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function normalizeDateForMatch(value: string): string {
  const trimmed = value.trim();
  const slash = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    return `${slash[1].padStart(2, "0")}/${slash[2].padStart(2, "0")}/${slash[3]}`;
  }
  return trimmed;
}

async function resolveWaystarEobPdfUrl(page: Page): Promise<string> {
  const currentUrl = page.url().trim();
  if (/ViewEOB\.aspx/i.test(currentUrl) || /\.pdf(?:[?#].*)?$/i.test(currentUrl)) {
    return currentUrl;
  }

  const embeddedUrl = await page.evaluate(() => {
    const candidates: string[] = [];
    for (const selector of [
      "embed[src]",
      "iframe[src]",
      "object[data]",
      "a[href]",
    ]) {
      for (const node of Array.from(document.querySelectorAll(selector))) {
        const element = node as HTMLElement;
        const raw = element.getAttribute("src") || element.getAttribute("data") || element.getAttribute("href") || "";
        if (!raw) continue;
        try {
          candidates.push(new URL(raw, window.location.href).toString());
        } catch {
          // Ignore malformed URLs.
        }
      }
    }

    return candidates.find((candidate) => /ViewEOB\.aspx/i.test(candidate) || /\.pdf(?:[?#].*)?$/i.test(candidate)) || "";
  }).catch(() => "");

  return embeddedUrl.trim();
}

async function downloadWaystarPdfBuffer(page: Page, url: string): Promise<Buffer | null> {
  if (!url) return null;

  const cookies = await page.context().cookies(url).catch(() => []);
  const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "Mozilla/5.0");

  const response = await fetch(url, {
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      accept: "application/pdf,*/*",
      referer: page.url(),
      "user-agent": userAgent,
    },
  }).catch(() => null);

  if (!response?.ok) {
    return null;
  }

  const pdfBytes = Buffer.from(await response.arrayBuffer());
  return pdfBytes.length > 0 ? pdfBytes : null;
}

export async function extractWaystarEobText(page: Page): Promise<string> {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const pdfUrl = await resolveWaystarEobPdfUrl(page);
  if (!pdfUrl) {
    return bodyText;
  }

  const pdfBuffer = await downloadWaystarPdfBuffer(page, pdfUrl);
  if (!pdfBuffer) {
    return bodyText;
  }

  const pdfText = await extractTextFromPdf(pdfBuffer).catch(() => "");
  return pdfText.trim() || bodyText;
}

function isLikelyProcToken(token: string): boolean {
  const trimmed = token.trim().toUpperCase();
  if (!trimmed) return false;
  const blocked = new Set([
    "PROC",
    "REMARK",
    "SUB",
    "TOTAL",
    "GLOSSARY",
    "PROV",
    "PAID",
    "BILLED",
    "ALLOWED",
    "DEDUCT",
    "COINS",
    "DATE",
    "POS",
    "NOS",
    "MODS",
    "CHECK",
    "AMT",
    "GRP/RC--AMT",
    "GRP/RC-AMT",
  ]);
  if (blocked.has(trimmed)) return false;
  if (/^(CO|PR|OA|PI)-\d+$/i.test(trimmed)) return false;
  return /^(?=.*\d)[A-Z0-9.-]{4,12}$/.test(trimmed);
}

function extractField(text: string, labels: string[]): string {
  for (const label of labels) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lineStartRegex = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*[:#-]?\\s*(.+)$`, "im");
    const lineStartMatch = text.match(lineStartRegex);
    if (lineStartMatch?.[1]?.trim()) return lineStartMatch[1].trim();

    const inlineRegex = new RegExp(`\\b${escaped}\\b\\s*[:#-]?\\s*([^\\n]+)`, "i");
    const inlineMatch = text.match(inlineRegex);
    if (inlineMatch?.[1]?.trim()) return inlineMatch[1].trim();
  }
  return "";
}

function extractGlossary(text: string): Map<string, string> {
  const glossary = new Map<string, string>();
  const glossaryStart = text.search(/(?:^|\n)\s*glossary\b/i);
  const glossaryText = glossaryStart >= 0 ? text.slice(glossaryStart) : text;

  const prefixedRegex = /(?:^|\n)\s*(?:CO|PR|OA|PI)-?(\d{1,4})\s*[:\-]?\s*([^\n]*[A-Za-z][^\n]*)(?=\n\s*(?:(?:CO|PR|OA|PI)-?\d{1,4}\b|\d{1,4}\s*[A-Za-z]|$)|$)/gim;
  for (const match of glossaryText.matchAll(prefixedRegex)) {
    const code = match[1]?.trim();
    const reason = match[2]?.replace(/\s+/g, ' ').trim();
    if (code && reason && !glossary.has(code)) {
      glossary.set(code, reason);
    }
  }

  const numericRegex = /(?:^|\n)\s*(\d{1,4})\s*[:\-]?\s*([^\n]*[A-Za-z][^\n]*)(?=\n\s*(?:(?:CO|PR|OA|PI)-?\d{1,4}\b|\d{1,4}\s*[A-Za-z]|$)|$)/gim;
  for (const match of glossaryText.matchAll(numericRegex)) {
    const code = match[1]?.trim();
    const reason = match[2]?.replace(/\s+/g, ' ').trim();
    if (code && reason && !glossary.has(code)) {
      glossary.set(code, reason);
    }
  }

  return glossary;
}


function extractAccount(text: string): string {
  const match = text.match(/\bACNT\s*:\s*(?:[A-Z0-9-]+\/)?([A-Z0-9-]+)/i);
  return match?.[1]?.trim() || "";
}

function extractMoneyField(text: string, labels: string[]): string {
  const value = extractField(text, labels);
  const match = value.match(/([\d,]+\.\d{2})/);
  return match?.[1]?.replace(/,/g, "") || "";
}

function parseWaystarCompactDate(token: string): string {
  const trimmed = token.trim();
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(trimmed)) {
    const parts = trimmed.split('/');
    const month = parts[0].padStart(2, '0');
    const day = parts[1].padStart(2, '0');
    const year = parts[2].length === 2 ? `20${parts[2]}` : parts[2];
    return `${year}-${month}-${day}`;
  }
  if (!/^\d{5,6}$/.test(trimmed)) return "";
  const digits = trimmed;
  const month = digits.length === 5 ? digits.slice(0, 1) : digits.slice(0, 2);
  const day = digits.length === 5 ? digits.slice(1, 3) : digits.slice(2, 4);
  const year = digits.slice(-2);
  return `20${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

function isMoneyToken(token: string): boolean {
  return /^\d+\.\d{2}$/.test(token.trim());
}

function padDenialReasons(codes: string[], glossary: Map<string, string>): string[] {
  return codes.map((code) => glossary.get(code.replace(/^(?:CO|PR|OA|PI)-?(\d{1,4})$/i, '$1')) || glossary.get(code) || '');
}
function extractSubTotals(text: string): string {
  const lines = text.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  const exactLine = lines.find((entry) => /^sub\s*totals?/i.test(entry));
  if (exactLine) return exactLine;

  const partialLine = lines.find((entry) => /sub\s*totals?/i.test(entry));
  return partialLine?.trim() || "";
}

function uniqueJoin(values: string[]): string {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).join("; ");
}

function extractDenialCodes(line: string): string[] {
  return Array.from(
    line.matchAll(/\b((?:CO|PR|OA|PI)-?\d{1,4})\b/gi),
    (match) => (match[1] || "").trim().toUpperCase().replace(/^(CO|PR|OA|PI)(\d)$/i, "$1-$2").replace(/^(CO|PR|OA|PI)(\d{2,4})$/i, "$1-$2"),
  ).filter(Boolean);
}

function sanitizeExtractedName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/(?:\bMBR\s*:|\bACNT\s*:|\bICN\s*:)/i.test(trimmed)) {
    const cleaned = trimmed.split(/\bMBR\s*:|\bACNT\s*:|\bICN\s*:/i)[0]?.trim() || "";
    return cleaned;
  }
  return trimmed;
}

function extractPdfRowProcToken(tokens: string[]): string {
  if (tokens.length === 0) return "";
  if (tokens.some((token) => /^(?:MBR|ACNT|ICN):/i.test(token))) {
    return "";
  }

  if (
    tokens.length >= 4
    && /^\d{4,8}$/.test(tokens[0] || "")
    && /^\d{1,2}$/.test(tokens[1] || "")
    && /^\d{1,2}$/.test(tokens[2] || "")
    && isLikelyProcToken(tokens[3] || "")
  ) {
    return tokens[3];
  }

  if (
    tokens.length >= 3
    && /^\d{1,2}$/.test(tokens[0] || "")
    && /^\d{1,2}$/.test(tokens[1] || "")
    && isLikelyProcToken(tokens[2] || "")
  ) {
    return tokens[2];
  }

  for (let index = 0; index < Math.min(tokens.length, 6); index += 1) {
    const token = (tokens[index] || "").trim();
    if (!token || token.includes(":")) continue;
    if (/^\d{1,2}$/.test(token)) continue;
    if (/^\d{4,8}$/.test(token) && index === 0) continue;
    if (/^\d+\.\d{2}$/.test(token)) continue;
    if (!isLikelyProcToken(token)) continue;
    return token;
  }

  return "";
}

function extractPdfStyleProcedureLines(text: string): WaystarProcedureLine[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const glossary = extractGlossary(text);
  const subTotals = extractSubTotals(text);
  const results: WaystarProcedureLine[] = [];
  let current: WaystarProcedureLine | null = null;
  let inGlossarySection = false;

  for (const line of lines) {
    if (/^glossary\b/i.test(line)) {
      inGlossarySection = true;
      continue;
    }
    if (inGlossarySection) continue;

    if (/^date\s+pos\s+nos\s+proc\b/i.test(line)
      || /^claims\s+billed\s+amt\b/i.test(line)
      || /^provider\.\s*reason/i.test(line)
      || /^obligations\./i.test(line)
      || /^coverage\s+under/i.test(line)
      || /^not\s+equal/i.test(line)
      || /^code\s+pending/i.test(line)
      || /^amount$/i.test(line)
      || /^interest\s+/i.test(line)
      || /^late\s+filing\s+charge/i.test(line)
      || /^prev\s+pd/i.test(line)
      || /^sub\s+totals?/i.test(line)
      || /^(name|patient name|member name|check date|acnt|account|icn|mbr)\s*:/i.test(line)) {
      continue;
    }

    const denialCodes = extractDenialCodes(line);
    const startsWithDenialCode = /^\s*(?:CO|PR|OA|PI)-?\d{1,4}\b/i.test(line);
    const isGlossaryReasonLine = startsWithDenialCode && /[A-Za-z]/.test(line.replace(/^\s*(?:CO|PR|OA|PI)-?\d{1,4}\s*[:\-]?\s*/i, ''));
    if (isGlossaryReasonLine) continue;

    const tokens = line.split(/\s+/).filter(Boolean);
    let serviceDate = '';
    let proc = '';
    let billed = '';
    let allowed = '';
    let deduct = '';
    let coins = '';
    let provPd = '';

    if (
      tokens.length >= 8
      && /^\d{5,6}$/.test(tokens[0] || '')
      && /^\d{1,2}$/.test(tokens[1] || '')
      && /^\d{1,2}$/.test(tokens[2] || '')
      && isLikelyProcToken(tokens[3] || '')
    ) {
      serviceDate = parseWaystarCompactDate(tokens[0] || '');
      proc = tokens[3] || '';
      let amountIndex = 4;
      if (!isMoneyToken(tokens[amountIndex] || '')) {
        amountIndex += 1;
      }
      billed = tokens[amountIndex] || '';
      allowed = tokens[amountIndex + 1] || '';
      deduct = tokens[amountIndex + 2] || '';
      coins = tokens[amountIndex + 3] || '';
      provPd = isMoneyToken(tokens[tokens.length - 1] || '') ? (tokens[tokens.length - 1] || '') : '';
    } else if (
      tokens.length >= 7
      && /^\d{1,2}$/.test(tokens[0] || '')
      && /^\d{1,2}$/.test(tokens[1] || '')
      && isLikelyProcToken(tokens[2] || '')
    ) {
      proc = tokens[2] || '';
      let amountIndex = 3;
      if (!isMoneyToken(tokens[amountIndex] || '')) {
        amountIndex += 1;
      }
      billed = tokens[amountIndex] || '';
      allowed = tokens[amountIndex + 1] || '';
      deduct = tokens[amountIndex + 2] || '';
      coins = tokens[amountIndex + 3] || '';
      provPd = isMoneyToken(tokens[tokens.length - 1] || '') ? (tokens[tokens.length - 1] || '') : '';
    }

    if (
      proc
      && isMoneyToken(billed)
      && isMoneyToken(allowed)
      && isMoneyToken(deduct)
      && isMoneyToken(coins)
    ) {
      current = {
        serviceDate,
        proc,
        billed,
        allowed,
        deduct,
        coins,
        provPd,
        subTotals,
        denialCodes: [...denialCodes],
        denialReasons: padDenialReasons(denialCodes, glossary),
      };
      results.push(current);
      continue;
    }

    if (current && denialCodes.length > 0) {
      current.denialCodes = Array.from(new Set([...current.denialCodes, ...denialCodes]));
      current.denialReasons = padDenialReasons(current.denialCodes, glossary);
    }
  }

  return results;
}


function extractProcedureLines(text: string): WaystarProcedureLine[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const glossary = extractGlossary(text);
  const subTotals = extractSubTotals(text);
  const pdfStyleResults = extractPdfStyleProcedureLines(text);

  if (pdfStyleResults.length > 0) {
    return pdfStyleResults;
  }

  const results: WaystarProcedureLine[] = [];
  let inGlossarySection = false;

  for (const line of lines) {
    if (/^glossary\b/i.test(line)) {
      inGlossarySection = true;
      continue;
    }
    if (inGlossarySection) continue;
    if (/additional information/i.test(line) || /^sub\s*totals?/i.test(line) || /^prev\s+pd/i.test(line) || /^interest\s+/i.test(line) || /^late\s+filing\s+charge/i.test(line)) {
      continue;
    }

    const tokens = line.split(/\s+/).filter(Boolean);
    const moneyTokens = tokens.filter((token) => isMoneyToken(token));

    let serviceDate = '';
    let proc = '';
    let billed = '';
    let allowed = '';
    let deduct = '';
    let coins = '';
    let provPd = '';

    if (
      tokens.length >= 8
      && /^\d{5,6}$/.test(tokens[0] || '')
      && /^\d{1,2}$/.test(tokens[1] || '')
      && /^\d{1,2}$/.test(tokens[2] || '')
      && isLikelyProcToken(tokens[3] || '')
    ) {
      serviceDate = parseWaystarCompactDate(tokens[0] || '');
      proc = tokens[3] || '';
      let amountIndex = 4;
      if (!isMoneyToken(tokens[amountIndex] || '')) {
        amountIndex += 1;
      }
      billed = tokens[amountIndex] || '';
      allowed = tokens[amountIndex + 1] || '';
      deduct = tokens[amountIndex + 2] || '';
      coins = tokens[amountIndex + 3] || '';
      provPd = isMoneyToken(tokens[tokens.length - 1] || '') ? (tokens[tokens.length - 1] || '') : '';
    } else if (
      tokens.length >= 7
      && /^\d{1,2}$/.test(tokens[0] || '')
      && /^\d{1,2}$/.test(tokens[1] || '')
      && isLikelyProcToken(tokens[2] || '')
    ) {
      proc = tokens[2] || '';
      let amountIndex = 3;
      if (!isMoneyToken(tokens[amountIndex] || '')) {
        amountIndex += 1;
      }
      billed = tokens[amountIndex] || '';
      allowed = tokens[amountIndex + 1] || '';
      deduct = tokens[amountIndex + 2] || '';
      coins = tokens[amountIndex + 3] || '';
      provPd = isMoneyToken(tokens[tokens.length - 1] || '') ? (tokens[tokens.length - 1] || '') : '';
    }

    const denialCodes = extractDenialCodes(line);
    const isSimpleRemarkRow = !proc && tokens.length >= 2 && isLikelyProcToken(tokens[0] || '') && denialCodes.length > 0;
    if (isSimpleRemarkRow) {
      proc = tokens[0] || '';
    }

    const hasValidAmountColumns = isMoneyToken(billed) && isMoneyToken(allowed) && isMoneyToken(deduct) && isMoneyToken(coins);
    if (!proc || (!hasValidAmountColumns && !isSimpleRemarkRow)) {
      continue;
    }

    results.push({
      serviceDate,
      proc,
      billed,
      allowed,
      deduct,
      coins,
      provPd,
      subTotals,
      denialCodes,
      denialReasons: padDenialReasons(denialCodes, glossary),
    });
  }

  if (results.length === 0) {
    return [{ serviceDate: '', proc: '', billed: '', allowed: '', deduct: '', coins: '', provPd: '', subTotals, denialCodes: [], denialReasons: [] }];
  }

  return results;
}

export function summarizeWaystarHistoryText(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^history$/i.test(line));
  return lines.slice(0, 8).join(" | ");
}

export function parseWaystarEobText(text: string): WaystarClaimExtraction {
  const procedureLines = extractProcedureLines(text);
  const hasDenials = procedureLines.some((line) => line.denialCodes.length > 0);

  return {
    name: sanitizeExtractedName(extractField(text, ["NAME", "PATIENT NAME", "Member Name"])),
    icn: extractField(text, ["ICN", "Claim Number", "Claim No", "Claim #"]),
    account: extractAccount(text),
    eft: extractField(text, ["EFT", "EFT #", "ACH", "CHECK #", "CHECK NUMBER"]),
    productionDate: extractField(text, ["PRODUCTION DATE", "EFT PRODUCTION DATE", "PROD DATE"]),
    checkDate: extractField(text, ["CHECK DATE", "Check Date", "Date Paid"]),
    checkAmount: extractMoneyField(text, ["CHECK AMT", "CHECK AMOUNT"]),
    status: hasDenials ? "Denial" : "Paid",
    remarks: "",
    historySummary: "",
    procedureLines,
  };
}

export function buildCallingExtraction(row: WaystarClaimInputRow, remarks: string, historySummary = ""): WaystarClaimExtraction {
  return {
    name: row.patientName,
    icn: "",
    account: "",
    eft: "",
    productionDate: "",
    checkDate: "",
    checkAmount: "",
    status: "Calling",
    remarks,
    historySummary,
    procedureLines: [{ serviceDate: row.dos, proc: "", billed: "", allowed: "", deduct: "", coins: "", provPd: "", subTotals: "", denialCodes: [], denialReasons: [] }],
  };
}

async function firstVisibleLocator(page: Page, selectors: readonly string[], timeout = 3000): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible({ timeout }).catch(() => false)) {
      return locator;
    }
  }
  return null;
}

async function clickFirstVisible(page: Page, selectors: readonly string[], timeout = 5000): Promise<boolean> {
  const locator = await firstVisibleLocator(page, selectors, timeout);
  if (!locator) return false;
  await locator.click();
  await page.waitForLoadState("networkidle").catch(() => {});
  return true;
}

async function fillIfVisible(page: Page, selectors: readonly string[], value: string): Promise<boolean> {
  if (!value) return false;
  const locator = await firstVisibleLocator(page, selectors);
  if (!locator) return false;
  await locator.fill("");
  await locator.fill(value);
  return true;
}

export async function loginToWaystarClaimStatus(page: Page, credentials: WaystarCredentials): Promise<void> {
  await loginToWaystar(page, credentials);
}

export async function navigateToWaystarClaimSearch(page: Page): Promise<void> {
  await clickFirstVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.navigation.claimsProcessing, 15000).catch(() => false);
  await clickFirstVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.navigation.professionalClaims, 15000).catch(() => false);
  await clickFirstVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.navigation.claims, 15000).catch(() => false);
  const opened = await clickFirstVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.navigation.claimSearch, 20000).catch(() => false);
  if (!opened) {
    await page.locator("#headerSearchLink, text=/Claim Search/i").first().waitFor({ state: "visible", timeout: 20000 });
  }
}

type WaystarMatchedRowCandidate = {
  row: Locator;
  score: number;
  transactionDateText: string;
};

function extractFirstDate(text: string): string {
  const match = text.match(/(\d{1,2}\/\d{1,2}\/\d{2,4})/);
  return match?.[1] ? normalizeDateForMatch(match[1]) : "";
}

function extractTransactionDateFromText(text: string): string {
  const labeledMatch = text.match(/transaction\s*date[^\d]*(\d{1,2}\/\d{1,2}\/\d{2,4})/i);
  if (labeledMatch?.[1]) {
    return normalizeDateForMatch(labeledMatch[1]);
  }

  const allDates = Array.from(text.matchAll(/(\d{1,2}\/\d{1,2}\/\d{2,4})/g), (match) => normalizeDateForMatch(match[1] || ""))
    .filter(Boolean);
  return allDates.length > 0 ? allDates[allDates.length - 1] : "";
}

function parseWaystarDateValue(value: string): number {
  const match = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!match) return Number.NEGATIVE_INFINITY;

  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3]);
  const time = Date.UTC(year, month - 1, day);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

async function waitForWaystarClaimSearchResults(page: Page): Promise<void> {
  const waiters = [
    ...WAYSTAR_CLAIM_STATUS_SELECTORS.results.rows.map((selector) =>
      page.locator(selector).first().waitFor({ state: "visible", timeout: 15000 }),
    ),
    ...WAYSTAR_CLAIM_STATUS_SELECTORS.results.noResults.map((selector) =>
      page.locator(selector).first().waitFor({ state: "visible", timeout: 15000 }),
    ),
  ];

  await Promise.any(waiters).catch(() => {
    throw new Error("Waystar Claim Search results did not finish loading after clicking Search.");
  });
}

type WaystarResultSnapshot = {
  marker: string;
  hasVisibleState: boolean;
};

async function captureWaystarResultSnapshot(page: Page): Promise<WaystarResultSnapshot> {
  const markers: string[] = [];

  for (const selector of WAYSTAR_CLAIM_STATUS_SELECTORS.results.noResults) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible({ timeout: 150 }).catch(() => false))) continue;
    const text = normalizeText((await locator.innerText().catch(() => "")).trim());
    markers.push(`no-results:${selector}:${text || "visible"}`);
  }

  for (const selector of WAYSTAR_CLAIM_STATUS_SELECTORS.results.rows) {
    const rows = page.locator(selector);
    const count = Math.min(await rows.count().catch(() => 0), 5);
    if (count <= 0) continue;

    for (let index = 0; index < count; index += 1) {
      const row = rows.nth(index);
      if (!(await row.isVisible({ timeout: 150 }).catch(() => false))) continue;
      const text = normalizeText((await row.innerText().catch(() => "")).trim());
      if (!text) continue;
      markers.push(`row:${selector}:${index}:${text}`);
    }
  }

  return {
    marker: markers.join("||"),
    hasVisibleState: markers.length > 0,
  };
}

async function waitForFreshWaystarClaimSearchResults(page: Page, previousSnapshot: WaystarResultSnapshot): Promise<void> {
  const timeoutAt = Date.now() + 15000;
  let latestSnapshot = previousSnapshot;

  while (Date.now() < timeoutAt) {
    await waitForWaystarClaimSearchResults(page).catch(() => {});
    latestSnapshot = await captureWaystarResultSnapshot(page);
    if (latestSnapshot.hasVisibleState && latestSnapshot.marker !== previousSnapshot.marker) {
      return;
    }
    await page.waitForTimeout(250);
  }

  if (latestSnapshot.hasVisibleState) {
    return;
  }

  throw new Error("Waystar Claim Search results did not finish loading after clicking Search.");
}

async function findTransactionDateColumnIndex(page: Page): Promise<number> {
  for (const selector of WAYSTAR_CLAIM_STATUS_SELECTORS.results.headers) {
    const headers = page.locator(selector);
    const count = await headers.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const headerText = (await headers.nth(index).innerText().catch(() => "")).trim();
      if (/transaction\s*date/i.test(headerText)) {
        return index;
      }
    }
  }

  return -1;
}

async function readRowCellTexts(row: Locator): Promise<string[]> {
  const cellTexts = await row.locator("td, [role='cell']").evaluateAll((nodes) =>
    nodes.map((node) => (node.textContent || "").trim()).filter(Boolean),
  ).catch(() => [] as string[]);

  if (cellTexts.length > 0) {
    return cellTexts;
  }

  const fallbackText = (await row.innerText().catch(() => "")).trim();
  return fallbackText ? [fallbackText] : [];
}

export function pickBestWaystarClaimCandidate<T extends { score: number; transactionDateText: string }>(
  candidates: T[],
): T | null {
  let best: T | null = null;
  let bestTransactionDate = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    const currentTransactionDate = parseWaystarDateValue(candidate.transactionDateText);
    if (!best || candidate.score > best.score) {
      best = candidate;
      bestTransactionDate = currentTransactionDate;
      continue;
    }

    if (candidate.score === best.score && currentTransactionDate > bestTransactionDate) {
      best = candidate;
      bestTransactionDate = currentTransactionDate;
    }
  }

  return best;
}

async function firstVisibleRowActionLocator(row: Locator, selectors: readonly string[], timeout = 1500): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = row.locator(selector).first();
    if (!(await locator.isVisible({ timeout }).catch(() => false))) continue;
    if (await locator.isDisabled().catch(() => false)) continue;
    return locator;
  }

  return null;
}

async function firstVisibleEnabledLocator(page: Page, selectors: readonly string[], timeout = 3000): Promise<Locator | null> {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (!(await locator.isVisible({ timeout }).catch(() => false))) continue;
    if (await locator.isDisabled().catch(() => false)) continue;
    return locator;
  }

  return null;
}

async function activateWaystarResultRow(page: Page, row: Locator): Promise<void> {
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.click().catch(() => {});

  const firstCell = row.locator("td, [role='cell']").first();
  const hoverTarget = await firstCell.isVisible({ timeout: 1000 }).catch(() => false) ? firstCell : row;

  await hoverTarget.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, clientX: rect.left + 8, clientY: rect.top + Math.max(4, rect.height / 2) };
    node.dispatchEvent(new MouseEvent("mouseenter", init));
    node.dispatchEvent(new MouseEvent("mouseover", init));
    node.dispatchEvent(new MouseEvent("mousemove", init));
  }).catch(() => {});

  await hoverTarget.hover().catch(() => {});

  const box = await hoverTarget.boundingBox().catch(() => null);
  if (!box) {
    await page.waitForTimeout(250);
    return;
  }

  const outsideX = Math.max(1, box.x - 24);
  const centerY = box.y + Math.max(2, Math.min(box.height / 2, box.height - 2));
  const checkpoints = [
    box.x + Math.max(6, box.width * 0.08),
    box.x + Math.max(12, box.width * 0.25),
    box.x + Math.max(20, box.width * 0.5),
    box.x + Math.max(24, box.width * 0.82),
  ].map((value) => Math.min(box.x + box.width - 2, value));

  await page.mouse.move(outsideX, centerY, { steps: 6 }).catch(() => {});
  for (const x of checkpoints) {
    await page.mouse.move(x, centerY, { steps: 14 }).catch(() => {});
    await page.waitForTimeout(140);
  }

  await page.waitForTimeout(350);
}

type SamePageReadinessOptions = {
  selectors?: readonly string[];
  textMarkers?: readonly string[];
  minimumTextMatches?: number;
  timeoutMs?: number;
  urlIncludes?: readonly string[];
};

async function waitForActionMenuVisible(page: Page): Promise<boolean> {
  const menu = page.locator("#gridActionMenu .innerGridActionDiv, .gridActionMenu .innerGridActionDiv").first();
  const timeoutAt = Date.now() + 4000;

  while (Date.now() < timeoutAt) {
    if (await menu.isVisible({ timeout: 200 }).catch(() => false)) {
      return true;
    }
    await page.waitForTimeout(150);
  }

  return false;
}

async function waitForSamePageReadiness(page: Page, options: SamePageReadinessOptions | undefined): Promise<boolean> {
  if (!options) return false;

  const timeoutAt = Date.now() + (options.timeoutMs ?? 5000);

  while (Date.now() < timeoutAt) {
    if (options.urlIncludes?.length) {
      const currentUrl = normalizeText(page.url());
      if (options.urlIncludes.some((fragment) => currentUrl.includes(normalizeText(fragment)))) {
        return true;
      }
    }

    if (options.selectors?.length) {
      const readyLocator = await firstVisibleEnabledLocator(page, options.selectors, 300);
      if (readyLocator) {
        return true;
      }
    }

    if (options.textMarkers?.length) {
      const minimumTextMatches = options.minimumTextMatches ?? Math.min(2, options.textMarkers.length);
      const bodyText = normalizeText(await page.locator("body").innerText().catch(() => ""));
      const matches = options.textMarkers.reduce((count, marker) => count + (bodyText.includes(normalizeText(marker)) ? 1 : 0), 0);
      if (matches >= minimumTextMatches) {
        return true;
      }
    }

    await page.waitForTimeout(200);
  }

  return false;
}

async function revealRowActionButton(page: Page, row: Locator, selectors: readonly string[]): Promise<Locator | null> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await activateWaystarResultRow(page, row).catch(() => {});
    await waitForActionMenuVisible(page).catch(() => false);

    const rowActionButton = await firstVisibleRowActionLocator(row, selectors, 1000);
    if (rowActionButton) {
      return rowActionButton;
    }

    const exactHistoryButton = page.locator("#gridActionMenu .innerGridActionDiv #gridActionHistory, .innerGridActionDiv #gridActionHistory, #gridActionHistory").first();
    if (await exactHistoryButton.isVisible({ timeout: 1500 }).catch(() => false)) {
      return exactHistoryButton;
    }

    const pageActionButton = await firstVisibleEnabledLocator(page, selectors, 2000);
    if (pageActionButton) {
      return pageActionButton;
    }

    await page.waitForTimeout(250);
  }

  return null;
}

async function moveMouseToLocator(page: Page, locator: Locator): Promise<void> {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await locator.hover().catch(() => {});

  const box = await locator.boundingBox().catch(() => null);
  if (!box) return;

  const targetX = box.x + Math.max(3, Math.min(box.width / 2, box.width - 3));
  const targetY = box.y + Math.max(3, Math.min(box.height / 2, box.height - 3));
  const entryX = Math.max(1, targetX - 25);

  await page.mouse.move(entryX, targetY, { steps: 8 }).catch(() => {});
  await page.mouse.move(targetX, targetY, { steps: 12 }).catch(() => {});
  await page.waitForTimeout(150);
}

async function clickWaystarHistoryAction(page: Page, historyButton: Locator): Promise<boolean> {
  await moveMouseToLocator(page, historyButton).catch(() => {});
  const clickedPrimary = await historyButton.click({ force: true }).then(() => true).catch(async () => {
    await moveMouseToLocator(page, historyButton).catch(() => {});
    return historyButton.evaluate((node: Element) => {
      (node as HTMLElement).click();
      return true;
    }).catch(() => false);
  });
  if (clickedPrimary) {
    return true;
  }

  const exactHistoryButton = page.locator("#gridActionMenu .innerGridActionDiv #gridActionHistory, .innerGridActionDiv #gridActionHistory, #gridActionHistory").first();
  if (await exactHistoryButton.count().catch(() => 0)) {
    await moveMouseToLocator(page, exactHistoryButton).catch(() => {});
    const clickedExact = await exactHistoryButton.click({ force: true }).then(() => true).catch(async () => {
      return exactHistoryButton.evaluate((node: Element) => {
        (node as HTMLElement).click();
        return true;
      }).catch(() => false);
    });
    if (clickedExact) {
      return true;
    }
  }

  for (const selector of WAYSTAR_CLAIM_STATUS_SELECTORS.results.historyButtons) {
    const locator = page.locator(selector).first();
    if (!(await locator.count().catch(() => 0))) continue;
    await moveMouseToLocator(page, locator).catch(() => {});
    const clickedFallback = await locator.click({ force: true }).then(() => true).catch(async () => {
      return locator.evaluate((node: Element) => {
        (node as HTMLElement).click();
        return true;
      }).catch(() => false);
    });
    if (clickedFallback) {
      return true;
    }
  }

  return false;
}

async function openPopupFromAction(
  page: Page,
  action: Locator,
  samePageReadiness?: SamePageReadinessOptions,
  options: { skipScroll?: boolean; forceClick?: boolean } = {},
): Promise<Page | null> {
  const existingPages = new Set(page.context().pages());
  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  const contextPagePromise = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);

  if (!options.skipScroll) {
    await action.scrollIntoViewIfNeeded().catch(() => {});
  }
  await action.click({ force: options.forceClick ?? false }).catch(async () => {
    await action.evaluate((node: Element) => (node as HTMLElement).click()).catch(() => {});
  });

  const candidates = [await popupPromise, await contextPagePromise].filter((candidate): candidate is Page => Boolean(candidate));
  const popup = candidates.find((candidate) => !existingPages.has(candidate))
    ?? page.context().pages().find((candidate) => !existingPages.has(candidate))
    ?? null;

  if (!popup) {
    await page.waitForLoadState("networkidle").catch(() => {});
    if (await waitForSamePageReadiness(page, samePageReadiness)) {
      return page;
    }
    return null;
  }

  await popup.waitForLoadState("domcontentloaded").catch(() => {});
  await popup.waitForLoadState("networkidle").catch(() => {});
  await waitForSamePageReadiness(popup, samePageReadiness).catch(() => false);
  await popup.bringToFront().catch(() => {});
  return popup;
}

export async function searchWaystarClaim(page: Page, row: WaystarClaimInputRow): Promise<void> {
  const previousSnapshot = await captureWaystarResultSnapshot(page);
  const resetButton = await firstVisibleLocator(page, WAYSTAR_CLAIM_STATUS_SELECTORS.search.resetButton, 1000);
  if (resetButton) {
    await resetButton.click().catch(() => {});
  }

  await fillIfVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.search.patientName, row.patientName);
  await fillIfVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.search.claimNumber, row.claimNumber);
  const usedSingleDos = await fillIfVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.search.singleDos, row.dos);
  if (!usedSingleDos) {
    await fillIfVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.search.dosFrom, row.dos);
    await fillIfVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.search.dosTo, row.dos);
  }
  await fillIfVisible(page, WAYSTAR_CLAIM_STATUS_SELECTORS.search.payer, row.responsiblePayer);

  const searchButton = await firstVisibleLocator(page, WAYSTAR_CLAIM_STATUS_SELECTORS.search.searchButton, 5000);
  if (!searchButton) {
    throw new Error("Waystar Claim Search submit button was not found.");
  }

  await Promise.all([
    page.waitForLoadState("networkidle").catch(() => {}),
    searchButton.click(),
  ]);
  await waitForFreshWaystarClaimSearchResults(page, previousSnapshot);
}

export async function findMatchingClaimRow(page: Page, row: WaystarClaimInputRow): Promise<Locator | null> {
  await waitForWaystarClaimSearchResults(page);

  for (const selector of WAYSTAR_CLAIM_STATUS_SELECTORS.results.noResults) {
    const noResults = page.locator(selector).first();
    if (await noResults.isVisible({ timeout: 500 }).catch(() => false)) {
      return null;
    }
  }

  let rowLocator: Locator | null = null;
  for (const selector of WAYSTAR_CLAIM_STATUS_SELECTORS.results.rows) {
    const currentRows = page.locator(selector);
    const count = await currentRows.count().catch(() => 0);
    if (count > 0) {
      rowLocator = currentRows;
      break;
    }
  }
  if (!rowLocator) return null;

  const patientName = normalizeText(row.patientName);
  const claimNumber = normalizeClaimNumber(row.claimNumber);
  const payer = normalizePayer(row.responsiblePayer);
  const dos = normalizeDateForMatch(row.dos);
  const transactionDateColumnIndex = await findTransactionDateColumnIndex(page);
  const candidates: WaystarMatchedRowCandidate[] = [];
  const count = await rowLocator.count().catch(() => 0);

  for (let index = 0; index < count; index += 1) {
    const current = rowLocator.nth(index);
    const cellTexts = await readRowCellTexts(current);
    const rawText = cellTexts.join(" ") || (await current.innerText().catch(() => "")) || "";
    const text = normalizeText(rawText);
    if (!text) continue;

    const normalizedClaimText = normalizeClaimNumber(rawText);
    if (claimNumber && !normalizedClaimText.includes(claimNumber)) continue;

    const score =
      (patientName && text.includes(patientName) ? 3 : 0) +
      (claimNumber && normalizedClaimText.includes(claimNumber) ? 4 : 0) +
      (payer && normalizePayer(text).includes(payer) ? 2 : 0) +
      (dos && text.includes(dos) ? 2 : 0);

    if (score <= 0) continue;

    const transactionDateText = transactionDateColumnIndex >= 0 && cellTexts[transactionDateColumnIndex]
      ? extractFirstDate(cellTexts[transactionDateColumnIndex])
      : extractTransactionDateFromText(rawText);

    candidates.push({
      row: current,
      score,
      transactionDateText,
    });
  }

  return pickBestWaystarClaimCandidate(candidates)?.row ?? null;
}

export async function openWaystarClaimContext(page: Page, matchedRow: Locator): Promise<Page> {
  for (const selector of WAYSTAR_CLAIM_STATUS_SELECTORS.results.detailLinks) {
    const clickable = matchedRow.locator(selector).first();
    if (!(await clickable.isVisible({ timeout: 400 }).catch(() => false))) continue;

    const popupPromise = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await clickable.click().catch(async () => {
      await matchedRow.click();
    });
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState("domcontentloaded").catch(() => {});
      await popup.bringToFront().catch(() => {});
      return popup;
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    return page;
  }

  return page;
}

export async function openWaystarHistoryPopup(page: Page, matchedRow: Locator): Promise<Page | null> {
  const historyButton = await revealRowActionButton(page, matchedRow, WAYSTAR_CLAIM_STATUS_SELECTORS.results.historyButtons);
  if (!historyButton) {
    return null;
  }

  const existingPages = new Set(page.context().pages());
  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  const contextPagePromise = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);

  const clicked = await clickWaystarHistoryAction(page, historyButton);
  if (!clicked) {
    return null;
  }

  const candidates = [await popupPromise, await contextPagePromise].filter((candidate): candidate is Page => Boolean(candidate));
  const popup = candidates.find((candidate) => !existingPages.has(candidate))
    ?? page.context().pages().find((candidate) => !existingPages.has(candidate))
    ?? null;

  if (popup) {
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    await popup.waitForLoadState("networkidle").catch(() => {});
    await waitForSamePageReadiness(popup, {
      selectors: WAYSTAR_CLAIM_STATUS_SELECTORS.results.eobButtons,
      textMarkers: ["history", "eob"],
      minimumTextMatches: 1,
      timeoutMs: 15000,
    }).catch(() => false);
    await popup.bringToFront().catch(() => {});
    return popup;
  }

  await page.waitForLoadState("networkidle").catch(() => {});
  if (await waitForSamePageReadiness(page, {
    selectors: WAYSTAR_CLAIM_STATUS_SELECTORS.results.eobButtons,
    textMarkers: ["history", "eob"],
  })) {
    return page;
  }

  return null;
}

export async function openWaystarEobPopup(page: Page): Promise<Page | null> {
  const exactEobButton = page.locator("button.mediumDefaultButton.actionBarButton.viewClaimEOBButton.link-open[data-new-window='true'][data-link-url*='ViewEOB.aspx']").filter({ hasText: /^\s*EOB\s*$/ }).first();
  const eobButton = await exactEobButton.isVisible({ timeout: 5000 }).catch(() => false)
    ? exactEobButton
    : await firstVisibleEnabledLocator(page, WAYSTAR_CLAIM_STATUS_SELECTORS.results.eobButtons, 10000);

  if (!eobButton) {
    return null;
  }

  const eobLabel = (await eobButton.innerText().catch(() => "")).trim().toUpperCase();
  if (eobLabel && eobLabel !== "EOB") {
    throw new Error(`Unexpected Waystar action button matched instead of EOB: ${eobLabel}`);
  }

  return openPopupFromAction(page, eobButton, {
    textMarkers: ["name", "icn", "check date", "sub totals"],
    minimumTextMatches: 2,
    timeoutMs: 15000,
    urlIncludes: ["vieweob", "eob"],
  }, {
    forceClick: true,
  });
}
