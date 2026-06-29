import type { Locator, Page } from "playwright-core";
import { blueShieldConfig } from "./config";
import { assertNoSecurityBlock } from "./detection-monitor";
import type { BlueShieldClaimSummary, BlueShieldMemberWorkItem } from "./types";

type BlueShieldResultRowData = {
  claimStatusLastModified: string;
  claimNumber: string;
  claimType: string;
  datesOfService: string;
  eob: string;
  memberName: string;
  memberIdSubscriberId: string;
  providerName: string;
  claimAmountBilled: string;
  claimAmountPaid: string;
  patientResponsibility: string;
};

type BlueShieldDetailData = {
  claim: {
    datesOfService: string;
    claimReceived: string;
    provider: string;
    providerNumber: string;
    nationalProviderIdentifier: string;
    ipaMedGroup: string;
    amountBilled: string;
    allowedAmount: string;
    patientResponsibility: string;
    amountPaid: string;
  };
  payment: {
    checkEftNumber: string;
    checkEftDate: string;
    checkEftStatus: string;
    checkEftAmount: string;
    payeeName: string;
    payeeAddress: string;
  };
  serviceLines: Array<{
    lineNumber: string;
    datesOfService: string;
    placeOfService: string;
    units: string;
    procedureCode: string;
    modifier: string;
    amountBilled: string;
    allowedAmount: string;
    deductible: string;
    copay: string;
    coInsurance: string;
    amountPaid: string;
  }>;
  claimNotes: string;
};

type BlueShieldServiceLine = BlueShieldDetailData["serviceLines"][number];

function firstMatch(text: string, pattern: RegExp): string {
  return text.match(pattern)?.[1]?.trim() ?? "";
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function normalizeHeader(value: string): string {
  return normalizeText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function valueByHeader(cellsByHeader: Map<string, string>, aliases: string[]): string {
  for (const alias of aliases) {
    const value = cellsByHeader.get(normalizeHeader(alias));
    if (value) return value;
  }
  return "";
}

function buildServiceLine(cellsByHeader: Map<string, string>): BlueShieldServiceLine {
  return {
    lineNumber: valueByHeader(cellsByHeader, ["Line #", "Line", "Line number"]),
    datesOfService: valueByHeader(cellsByHeader, ["Dates of service", "Date of service", "DOS"]),
    placeOfService: valueByHeader(cellsByHeader, ["Place of service"]),
    units: valueByHeader(cellsByHeader, ["Units"]),
    procedureCode: valueByHeader(cellsByHeader, ["Procedure code", "Procedure", "CPT"]),
    modifier: valueByHeader(cellsByHeader, ["Modifier", "Modifiers"]),
    amountBilled: valueByHeader(cellsByHeader, ["Amount billed", "Billed amount"]),
    allowedAmount: valueByHeader(cellsByHeader, ["Allowed amount", "Allowed"]),
    deductible: valueByHeader(cellsByHeader, ["Deductible"]),
    copay: valueByHeader(cellsByHeader, ["Copay", "Co-pay"]),
    coInsurance: valueByHeader(cellsByHeader, ["Co-Insurance", "Co Insurance", "Coinsurance"]),
    amountPaid: valueByHeader(cellsByHeader, ["Amount paid", "Paid amount"]),
  };
}

function hasServiceLineData(line: BlueShieldServiceLine): boolean {
  return Boolean(line.lineNumber || line.datesOfService || line.procedureCode || line.amountBilled || line.amountPaid);
}

function parseServiceLinesFromRows(headers: string[], rows: string[][]): BlueShieldServiceLine[] {
  const normalizedHeaders = headers.map(normalizeHeader);
  return rows
    .map((cells) => {
      const cellsByHeader = new Map<string, string>();
      for (let index = 0; index < cells.length; index++) {
        cellsByHeader.set(normalizedHeaders[index] || `column_${index + 1}`, normalizeText(cells[index] ?? ""));
      }
      return buildServiceLine(cellsByHeader);
    })
    .filter(hasServiceLineData);
}

function serviceLineQuality(line: BlueShieldServiceLine): number {
  const moneyFields = [
    line.amountBilled,
    line.allowedAmount,
    line.deductible,
    line.copay,
    line.coInsurance,
    line.amountPaid,
  ];
  const cleanMoneyCount = moneyFields.filter((value) => /^\$[0-9,]+(?:\.\d{2})?$/.test(value)).length;
  const malformedPenalty = moneyFields.some((value) => /\d{1,2}\/\d{1,2}\/\d{2,4}|Office|Procedure|Modifier/i.test(value)) ? 10 : 0;
  return [
    line.lineNumber ? 4 : 0,
    line.datesOfService ? 4 : 0,
    line.placeOfService ? 2 : 0,
    line.units ? 2 : 0,
    line.procedureCode ? 4 : 0,
    line.modifier ? 1 : 0,
    cleanMoneyCount,
  ].reduce((sum, value) => sum + value, 0) - malformedPenalty;
}

function mergeServiceLineSources(sources: BlueShieldServiceLine[][]): BlueShieldServiceLine[] {
  const byLineNumber = new Map<string, BlueShieldServiceLine>();
  const withoutLineNumber: BlueShieldServiceLine[] = [];

  for (const source of sources) {
    for (const line of source) {
      const key = line.lineNumber.trim();
      if (!key) {
        withoutLineNumber.push(line);
        continue;
      }
      const existing = byLineNumber.get(key);
      if (!existing || serviceLineQuality(line) > serviceLineQuality(existing)) {
        byLineNumber.set(key, line);
      }
    }
  }

  return [...Array.from(byLineNumber.values()), ...withoutLineNumber]
    .filter(hasServiceLineData)
    .sort((a, b) => Number(a.lineNumber || Number.MAX_SAFE_INTEGER) - Number(b.lineNumber || Number.MAX_SAFE_INTEGER));
}

function looksLikeServiceLineHeaders(headers: string[]): boolean {
  const normalized = headers.map(normalizeHeader).filter(Boolean);
  const headerText = normalized.join("|");
  const hasLine = normalized.some((header) => header === "line" || header === "linenumber" || header === "line");
  const hasProcedure = headerText.includes("procedure") || headerText.includes("cpt");
  const hasPaid = headerText.includes("amountpaid") || headerText.includes("paidamount");
  const hasDos = headerText.includes("datesofservice") || headerText.includes("dateofservice") || headerText.includes("dos");
  return hasLine && hasProcedure && hasPaid && hasDos;
}

function serviceHeaderCanonical(value: string): string {
  const normalized = normalizeHeader(value);
  if (normalized === "line" || normalized === "linenumber") return "Line #";
  if (normalized === "datesofservice" || normalized === "dateofservice" || normalized === "dos") return "Dates of service";
  if (normalized === "placeofservice") return "Place of service";
  if (normalized === "units") return "Units";
  if (normalized === "procedurecode" || normalized === "cpt") return "Procedure code";
  if (normalized === "modifier" || normalized === "modifiers") return "Modifier";
  if (normalized === "amountbilled" || normalized === "billedamount") return "Amount billed";
  if (normalized === "allowedamount" || normalized === "allowed") return "Allowed amount";
  if (normalized === "deductible") return "Deductible";
  if (normalized === "copay" || normalized === "copayment") return "Copay";
  if (normalized === "coinsurance" || normalized === "coinsurance") return "Co-Insurance";
  if (normalized === "amountpaid" || normalized === "paidamount") return "Amount paid";
  return value;
}

function parseServiceLinesFromText(text: string): BlueShieldServiceLine[] {
  const lines = text.split(/\r?\n/).map(normalizeText).filter(Boolean);
  const serviceLines: BlueShieldServiceLine[] = [];
  const lineStartPattern = /^(\d+)\s+(\d{1,2}\/\d{1,2}\/\d{2,4}\s*[-–]\s*\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+)$/;
  const moneyPattern = /\$[0-9,]+(?:\.\d{2})?/g;

  for (const line of lines) {
    const match = line.match(lineStartPattern);
    if (!match) continue;

    const rest = match[3];
    const moneyValues = rest.match(moneyPattern) ?? [];
    const firstMoney = moneyValues[0];
    const beforeMoney = firstMoney ? rest.slice(0, rest.indexOf(firstMoney)).trim() : rest;
    const tokens = beforeMoney.split(/\s+/).filter(Boolean);
    if (tokens.length < 4) continue;

    serviceLines.push({
      lineNumber: match[1],
      datesOfService: match[2].replace(/\s+/g, ""),
      placeOfService: tokens[0] ?? "",
      units: tokens[1] ?? "",
      procedureCode: tokens[2] ?? "",
      modifier: tokens.slice(3).join(" "),
      amountBilled: moneyValues[0] ?? "",
      allowedAmount: moneyValues[1] ?? "",
      deductible: moneyValues[2] ?? "",
      copay: moneyValues[3] ?? "",
      coInsurance: moneyValues[4] ?? "",
      amountPaid: moneyValues[5] ?? "",
    });
  }

  return serviceLines.length ? serviceLines : parseServiceLinesFromCellText(lines);
}

function parseServiceLinesFromCellText(lines: string[]): BlueShieldServiceLine[] {
  const startIndex = lines.findIndex((line) => normalizeHeader(line) === "serviceandproceduredetails");
  const sectionLines = lines
    .slice(startIndex >= 0 ? startIndex + 1 : 0)
    .slice(0, lines.length)
    .filter((line) => !/^(claim\s+message|claim\s+notes|claim\s+details|payment\s+details)$/i.test(line));
  const stopIndex = sectionLines.findIndex((line) => /^(claim\s+message|claim\s+notes|claim\s+details|payment\s+details)$/i.test(line));
  const cells = (stopIndex >= 0 ? sectionLines.slice(0, stopIndex) : sectionLines)
    .filter((line) => !isServiceLineHeaderText(line));
  const parsedLines: BlueShieldServiceLine[] = [];

  for (let index = 0; index < cells.length; index++) {
    const lineNumber = cells[index];
    if (!lineNumber || !/^\d+$/.test(lineNumber)) continue;

    const dates = readServiceDateFromCells(cells, index + 1);
    if (!dates.value) continue;

    let cursor = dates.nextIndex;
    const placeOfService = cells[cursor++] ?? "";
    const units = cells[cursor++] ?? "";
    const procedureCode = cells[cursor++] ?? "";
    const modifier = cells[cursor++] ?? "";
    const amountBilled = cells[cursor++] ?? "";
    const allowedAmount = cells[cursor++] ?? "";
    const deductible = cells[cursor++] ?? "";
    const copay = cells[cursor++] ?? "";
    const coInsurance = cells[cursor++] ?? "";
    const amountPaid = cells[cursor++] ?? "";

    const moneyValues = [amountBilled, allowedAmount, deductible, copay, coInsurance, amountPaid];
    if (!procedureCode || moneyValues.some((value) => !/^\$?[0-9,]+(?:\.\d{2})?$/.test(value))) {
      continue;
    }

    parsedLines.push({
      lineNumber,
      datesOfService: dates.value,
      placeOfService,
      units,
      procedureCode,
      modifier,
      amountBilled,
      allowedAmount,
      deductible,
      copay,
      coInsurance,
      amountPaid,
    });
    index = cursor - 1;
  }

  return parsedLines;
}

function isServiceLineHeaderText(value: string): boolean {
  const normalized = normalizeHeader(value);
  return [
    "line",
    "linenumber",
    "datesofservice",
    "datesof",
    "dateofservice",
    "dos",
    "service",
    "placeofservice",
    "placeof",
    "units",
    "procedurecode",
    "procedure",
    "code",
    "modifier",
    "amountbilled",
    "amount",
    "billed",
    "allowedamount",
    "allowed",
    "deductible",
    "copay",
    "coinsurance",
    "amountpaid",
    "paid",
  ].includes(normalized);
}

function readServiceDateFromCells(cells: string[], index: number): { value: string; nextIndex: number } {
  const first = cells[index] ?? "";
  const second = cells[index + 1] ?? "";
  const fullRange = first.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]\s*(\d{1,2}\/\d{1,2}\/\d{2,4})$/);
  if (fullRange) {
    return { value: `${fullRange[1]}-${fullRange[2]}`, nextIndex: index + 1 };
  }

  const firstDate = first.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*[-–]?$/);
  const secondDate = second.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})$/);
  if (firstDate && secondDate) {
    return { value: `${firstDate[1]}-${secondDate[1]}`, nextIndex: index + 2 };
  }

  return { value: "", nextIndex: index };
}

function serviceLineDebugPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  const serviceIndex = normalized.search(/service\s+and\s+procedure\s+details/i);
  const start = serviceIndex >= 0 ? serviceIndex : 0;
  return normalized.slice(start, start + 1000);
}

function moneyValue(value: string): number {
  const normalized = value.replace(/[^0-9.-]+/g, "");
  if (!normalized) return 0;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function computeClaimStatus(args: {
  detailAmountPaid: string;
  listAmountPaid: string;
  serviceLineAmountPaid: string;
  serviceLineCoInsurance: string;
  lineNotes: string;
  hasServiceLine: boolean;
}): string {
  const lineNotes = args.lineNotes.toLowerCase();
  if (/\bden(?:ied|ial)\b/.test(lineNotes)) return "Denied";
  if (/\bpaid\b/.test(lineNotes) && !/\bnot\s+paid\b/.test(lineNotes)) return "Paid";

  const paidAmount = args.hasServiceLine
    ? moneyValue(args.serviceLineAmountPaid)
    : moneyValue(args.detailAmountPaid) || moneyValue(args.listAmountPaid);
  if (paidAmount > 0) return "Paid";

  const hasZeroPaid =
    /\b0(?:\.00)?\b/.test(args.serviceLineAmountPaid) ||
    (!args.hasServiceLine && /\b0(?:\.00)?\b/.test(args.detailAmountPaid)) ||
    (!args.hasServiceLine && /\b0(?:\.00)?\b/.test(args.listAmountPaid));
  const hasZeroCoInsurance = /\b0(?:\.00)?\b/.test(args.serviceLineCoInsurance);
  return hasZeroPaid || hasZeroCoInsurance ? "Denied" : "";
}

function noteForServiceLine(claimNotes: string, serviceLineNumber: string): string {
  const lineNumber = serviceLineNumber.trim();
  if (!claimNotes || !lineNumber) return claimNotes;

  const escapedLineNumber = lineNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const linePattern = new RegExp(
    `\\bLINE\\s*(?:NUMBER\\s*)?#?\\s*${escapedLineNumber}\\b\\s*[:.-]?\\s*([\\s\\S]*?)(?=\\bLINE\\s*(?:NUMBER\\s*)?#?\\s*\\d+\\b|$)`,
    "i",
  );
  const match = claimNotes.match(linePattern);
  return normalizeText(match?.[1] ?? "") || claimNotes;
}

function dateKeysFromText(value: string): Set<string> {
  const keys = new Set<string>();
  const matches = value.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g);
  for (const match of matches) {
    const month = match[1].padStart(2, "0");
    const day = match[2].padStart(2, "0");
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    keys.add(`${year}-${month}-${day}`);
  }
  return keys;
}

function requestedDosKeys(workItem: BlueShieldMemberWorkItem, dosSearched: string): Set<string> {
  const keys = new Set<string>();
  for (const value of [...workItem.dosValues, dosSearched]) {
    for (const key of dateKeysFromText(value)) keys.add(key);
  }
  return keys;
}

function textMatchesRequestedDos(value: string, requestedKeys: Set<string>): boolean {
  if (!requestedKeys.size) return true;
  const candidateKeys = dateKeysFromText(value);
  return Array.from(candidateKeys).some((key) => requestedKeys.has(key));
}

function serviceLineMatchesRequestedDos(serviceLine: BlueShieldServiceLine, requestedKeys: Set<string>): boolean {
  return textMatchesRequestedDos(serviceLine.datesOfService, requestedKeys);
}

function claimSummaryKey(claim: BlueShieldClaimSummary): string {
  return [
    claim.memberId,
    claim.dosSearched,
    claim.claimNumber,
    claim.serviceLineNumber,
    claim.serviceLineDatesOfService,
    claim.procedureCode,
    claim.modifier,
    claim.serviceLineAmountBilled,
    claim.serviceLineAmountPaid,
  ]
    .map((value) => normalizeText(value).toUpperCase())
    .join("::");
}

function emptyDetailData(): BlueShieldDetailData {
  return {
    claim: {
      datesOfService: "",
      claimReceived: "",
      provider: "",
      providerNumber: "",
      nationalProviderIdentifier: "",
      ipaMedGroup: "",
      amountBilled: "",
      allowedAmount: "",
      patientResponsibility: "",
      amountPaid: "",
    },
    payment: {
      checkEftNumber: "",
      checkEftDate: "",
      checkEftStatus: "",
      checkEftAmount: "",
      payeeName: "",
      payeeAddress: "",
    },
    serviceLines: [],
    claimNotes: "",
  };
}

function valueAfterLabel(text: string, aliases: string[]): string {
  const lines = text.split(/\r?\n/).map(normalizeText).filter(Boolean);
  for (let index = 0; index < lines.length; index++) {
    const normalizedLine = normalizeHeader(lines[index]);
    for (const alias of aliases) {
      const normalizedAlias = normalizeHeader(alias);
      if (normalizedLine === normalizedAlias) {
        return lines[index + 1] && normalizeHeader(lines[index + 1]) !== normalizedAlias ? lines[index + 1] : "";
      }
      if (normalizedLine.startsWith(normalizedAlias)) {
        const inlineValue = lines[index].slice(alias.length).replace(/^[:\s-]+/, "").trim();
        if (inlineValue) return inlineValue;
      }
    }
  }
  return "";
}

async function extractKeyValueSection(page: Page, heading: string, labels: string[]): Promise<Record<string, string>> {
  const section = page.locator(`xpath=//*[self::h1 or self::h2 or self::h3 or self::h4][normalize-space()="${heading}"]/following::*[self::div or self::section][1]`).first();
  const sectionText = await section.innerText({ timeout: 3000 }).catch(async () => {
    const headingNode = page.locator(`text=${heading}`).first();
    return headingNode.locator("xpath=ancestor::*[self::div or self::section][1]").innerText({ timeout: 3000 }).catch(() => "");
  });
  const values: Record<string, string> = {};
  for (const label of labels) {
    values[label] = valueAfterLabel(sectionText, [label]);
  }
  return values;
}

async function extractServiceLines(page: Page, text: string): Promise<BlueShieldDetailData["serviceLines"]> {
  const gridCandidates = await page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const candidates: Array<{ headers: string[]; rows: string[][]; source: string }> = [];

    for (const table of Array.from(document.querySelectorAll("table"))) {
      const allRows = Array.from(table.querySelectorAll("tr"));
      const headerRows = allRows.filter((row) => row.querySelectorAll("th").length > 0);
      const headerSource = headerRows.at(-1) ?? allRows[0];
      const headers = Array.from(headerSource?.querySelectorAll("th, td") ?? [])
        .map((cell) => normalize((cell as HTMLElement).innerText || cell.textContent || ""));
      const rows = allRows
        .filter((row) => row !== headerSource && row.querySelectorAll("td").length > 0)
        .map((row) => Array.from(row.querySelectorAll("td")).map((cell) => normalize((cell as HTMLElement).innerText || cell.textContent || "")))
        .filter((cells) => cells.some(Boolean));
      if (headers.length && rows.length) candidates.push({ headers, rows, source: "table" });
    }

    for (const grid of Array.from(document.querySelectorAll("[role='table'], [role='grid']"))) {
      const roleRows = Array.from(grid.querySelectorAll("[role='row']"));
      const headerRow = roleRows.find((row) => row.querySelectorAll("[role='columnheader']").length > 0) ?? roleRows[0];
      const headers = Array.from(headerRow?.querySelectorAll("[role='columnheader'], [role='cell'], [role='gridcell']") ?? [])
        .map((cell) => normalize((cell as HTMLElement).innerText || cell.textContent || ""));
      const rows = roleRows
        .filter((row) => row !== headerRow)
        .map((row) => Array.from(row.querySelectorAll("[role='cell'], [role='gridcell']"))
          .map((cell) => normalize((cell as HTMLElement).innerText || cell.textContent || "")))
        .filter((cells) => cells.some(Boolean));
      if (headers.length && rows.length) candidates.push({ headers, rows, source: "role-grid" });
    }

    const headerAliases: Record<string, string> = {
      line: "Line #",
      linenumber: "Line #",
      datesofservice: "Dates of service",
      dateofservice: "Dates of service",
      dos: "Dates of service",
      placeofservice: "Place of service",
      units: "Units",
      procedurecode: "Procedure code",
      cpt: "Procedure code",
      modifier: "Modifier",
      modifiers: "Modifier",
      amountbilled: "Amount billed",
      billedamount: "Amount billed",
      allowedamount: "Allowed amount",
      allowed: "Allowed amount",
      deductible: "Deductible",
      copay: "Copay",
      copayment: "Copay",
      coinsurance: "Co-Insurance",
      amountpaid: "Amount paid",
      paidamount: "Amount paid",
    };
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
    };
    const items = Array.from(document.querySelectorAll("body *"))
      .filter(isVisible)
      .map((element) => {
        const text = normalize((element as HTMLElement).innerText || element.textContent || "");
        const rect = element.getBoundingClientRect();
        return {
          text,
          normalized: text.toLowerCase().replace(/[^a-z0-9]+/g, ""),
          left: rect.left,
          top: rect.top,
          bottom: rect.bottom,
          centerX: rect.left + rect.width / 2,
        };
      })
      .filter((item) => item.text && item.text.length <= 80)

    const headerItems = items
      .map((item) => ({ ...item, canonical: headerAliases[item.normalized] }))
      .filter((item) => item.canonical);
    const headerGroups: typeof headerItems[] = [];
    for (const item of headerItems) {
      const group = headerGroups.find((candidate) => Math.abs(candidate[0].top - item.top) <= 18);
      if (group) group.push(item);
      else headerGroups.push([item]);
    }
    const headerGroup = headerGroups
      .map((group) => {
        const byHeader = new Map<string, (typeof group)[number]>();
        for (const item of group) {
          const existing = byHeader.get(item.canonical);
          if (!existing || item.left < existing.left) byHeader.set(item.canonical, item);
        }
        return Array.from(byHeader.values()).sort((a, b) => a.left - b.left);
      })
      .filter((group) => {
        const headers = group.map((item) => item.canonical);
        return headers.includes("Line #") && headers.includes("Dates of service") && headers.includes("Procedure code") && headers.includes("Amount paid") && headers.length >= 6;
      })
      .sort((a, b) => b.length - a.length)[0];

    if (headerGroup) {
      const headers = headerGroup.map((item) => item.canonical);
      const headerBottom = Math.max(...headerGroup.map((item) => item.bottom));
      const claimMessageTop = items.find((item) => /^claim\s+message$/i.test(item.text))?.top ?? Number.POSITIVE_INFINITY;
      const dataItems = items
        .filter((item) => item.top > headerBottom + 4 && item.top < claimMessageTop)
        .filter((item) => !headerAliases[item.normalized])
        .filter((item) => item.centerX >= headerGroup[0].left - 40 && item.centerX <= headerGroup[headerGroup.length - 1].centerX + 80);
      const lineColumnX = headerGroup[0].centerX;
      const lineAnchors = dataItems
        .filter((item) => /^\d+$/.test(item.text) && Math.abs(item.centerX - lineColumnX) < 80)
        .sort((a, b) => a.top - b.top);
      const rows = lineAnchors.map((anchor, index) => {
        const nextTop = lineAnchors[index + 1]?.top ?? claimMessageTop;
        const rowItems = dataItems.filter((item) => item.top >= anchor.top - 8 && item.top < nextTop - 4);
        return headerGroup.map((header) => {
          const columnItems = rowItems
            .filter((item) => Math.abs(item.centerX - header.centerX) <= 70)
            .sort((a, b) => a.top - b.top || a.left - b.left);
          return columnItems.map((item) => item.text).join("-").replace(/-\s*-/g, "-");
        });
      }).filter((row) => row.some(Boolean));
      if (rows.length) candidates.push({ headers, rows, source: "visual-grid" });
    }

    return candidates;
  }).catch(() => null);

  const candidateLines = (gridCandidates ?? [])
    .filter((candidate) => looksLikeServiceLineHeaders(candidate.headers))
    .map((candidate) => parseServiceLinesFromRows(candidate.headers.map(serviceHeaderCanonical), candidate.rows))
    .filter((lines) => lines.length > 0);
  const textLines = parseServiceLinesFromText(text);
  const mergedLines = mergeServiceLineSources([...candidateLines, textLines]);
  if (mergedLines.length) return mergedLines;

  return [];
}

async function extractClaimNotes(page: Page, text: string): Promise<string> {
  const notesText = await page.evaluate(() => {
    const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
    const isClaimNotesHeading = (element: Element) => /^claim\s+notes$/i.test(normalize(element.textContent ?? ""));
    const isNextSectionHeading = (value: string) =>
      /^(claim details|payment details|service and procedure details|service details|procedure details)$/i.test(normalize(value));
    const heading = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6, div, span, p")).find(isClaimNotesHeading);
    if (!heading) return "";

    const siblingParts: string[] = [];
    let sibling = heading.nextElementSibling;
    while (sibling && siblingParts.length < 30) {
      const siblingText = normalize((sibling as HTMLElement).innerText || sibling.textContent || "");
      if (siblingText && isNextSectionHeading(siblingText)) break;
      if (siblingText) siblingParts.push(siblingText);
      sibling = sibling.nextElementSibling;
    }
    if (siblingParts.length) return siblingParts.join("\n");

    const parentText = normalize((heading.parentElement as HTMLElement | null)?.innerText || "");
    return parentText;
  }).catch(() => "");

  const sourceText = notesText || text;
  const lines = sourceText.split(/\r?\n/).map(normalizeText).filter(Boolean);
  const noteLines: string[] = [];
  let inNotes = !lines.some((line) => /^claim\s+notes$/i.test(line));

  for (const line of lines) {
    const header = normalizeHeader(line);
    if (/^claimnotes?$/.test(header)) {
      inNotes = true;
      continue;
    }
    if (inNotes && /^(claimdetails?|paymentdetails?|serviceandproceduredetails?|servicedetails?|proceduredetails?)$/.test(header)) {
      break;
    }
    if (inNotes && /^there are no notes for this claim\.?$/i.test(line)) {
      return "";
    }
    if (inNotes && /^line\s*\d+/i.test(line)) {
      noteLines.push(line.toUpperCase().replace(/\s+/g, " "));
      continue;
    }
    if (inNotes) {
      noteLines.push(line);
    }
  }

  if (!noteLines.length) {
    const inlineNotes = sourceText.match(/Claim\s+notes?\s*([\s\S]*?)(?:Claim details|Payment details|Service and procedure details|$)/i)?.[1] ?? "";
    return inlineNotes
      .split(/\r?\n/)
      .map((line) => normalizeText(line))
      .filter((line) => !/^there are no notes for this claim\.?$/i.test(line))
      .filter(Boolean)
      .join(" ");
  }

  return noteLines.filter(Boolean).join(" ");
}

async function extractDetailData(page: Page, text: string): Promise<BlueShieldDetailData> {
  const detailData = emptyDetailData();
  const claimDetails = await extractKeyValueSection(page, "Claim details", [
    "Dates of service",
    "Claim received",
    "Provider",
    "Provider number",
    "National Provider Identifier (NPI)",
    "NPI",
    "IPA/Med group",
    "Amount billed",
    "Allowed amount",
    "Patient responsibility",
    "Amount paid",
  ]);
  const paymentDetails = await extractKeyValueSection(page, "Payment details", [
    "Check/EFT number",
    "Check/EFT date",
    "Check/EFT status",
    "Check/EFT amount",
    "Payee name",
    "Payee address",
  ]);

  detailData.claim = {
    datesOfService: claimDetails["Dates of service"] || valueAfterLabel(text, ["Dates of service"]),
    claimReceived: claimDetails["Claim received"] || valueAfterLabel(text, ["Claim received"]),
    provider: claimDetails.Provider || valueAfterLabel(text, ["Provider"]),
    providerNumber: claimDetails["Provider number"] || valueAfterLabel(text, ["Provider number"]),
    nationalProviderIdentifier:
      claimDetails["National Provider Identifier (NPI)"] ||
      claimDetails.NPI ||
      valueAfterLabel(text, ["National Provider Identifier (NPI)", "NPI"]),
    ipaMedGroup: claimDetails["IPA/Med group"] || valueAfterLabel(text, ["IPA/Med group", "IPA Med group"]),
    amountBilled: claimDetails["Amount billed"] || valueAfterLabel(text, ["Amount billed"]),
    allowedAmount: claimDetails["Allowed amount"] || valueAfterLabel(text, ["Allowed amount"]),
    patientResponsibility: claimDetails["Patient responsibility"] || valueAfterLabel(text, ["Patient responsibility"]),
    amountPaid: claimDetails["Amount paid"] || valueAfterLabel(text, ["Amount paid"]),
  };
  detailData.payment = {
    checkEftNumber: paymentDetails["Check/EFT number"] || valueAfterLabel(text, ["Check/EFT number"]),
    checkEftDate: paymentDetails["Check/EFT date"] || valueAfterLabel(text, ["Check/EFT date"]),
    checkEftStatus: paymentDetails["Check/EFT status"] || valueAfterLabel(text, ["Check/EFT status"]),
    checkEftAmount: paymentDetails["Check/EFT amount"] || valueAfterLabel(text, ["Check/EFT amount"]),
    payeeName: paymentDetails["Payee name"] || valueAfterLabel(text, ["Payee name"]),
    payeeAddress: paymentDetails["Payee address"] || valueAfterLabel(text, ["Payee address"]),
  };
  detailData.serviceLines = await extractServiceLines(page, text);
  detailData.claimNotes = await extractClaimNotes(page, text);
  return detailData;
}

async function getResultHeaders(page: Page): Promise<string[]> {
  const table = page.locator(blueShieldConfig.selectors.resultTable).first();
  const headers = table.locator(blueShieldConfig.selectors.resultHeaders);
  const count = await headers.count();
  const values: string[] = [];
  for (let index = 0; index < count; index++) {
    values.push(normalizeText(await headers.nth(index).innerText().catch(() => "")));
  }
  return values.filter(Boolean);
}

async function extractResultRowData(row: Locator, headers: string[]): Promise<BlueShieldResultRowData> {
  const cells = row.locator("td");
  const cellCount = await cells.count();
  const cellsByHeader = new Map<string, string>();

  for (let index = 0; index < cellCount; index++) {
    const header = headers[index] ?? `column_${index + 1}`;
    cellsByHeader.set(normalizeHeader(header), normalizeText(await cells.nth(index).innerText().catch(() => "")));
  }

  return {
    claimStatusLastModified: valueByHeader(cellsByHeader, ["Claim status (Last modified)", "Claim status", "Status"]),
    claimNumber: valueByHeader(cellsByHeader, ["Claim number", "Claim #"]),
    claimType: valueByHeader(cellsByHeader, ["Claim type"]),
    datesOfService: valueByHeader(cellsByHeader, ["Dates of service", "Date of service", "DOS"]),
    eob: valueByHeader(cellsByHeader, ["EOB"]),
    memberName: valueByHeader(cellsByHeader, ["Member name"]),
    memberIdSubscriberId: valueByHeader(cellsByHeader, ["Member ID / Subscriber ID", "Member ID Subscriber ID", "Member ID", "Subscriber ID"]),
    providerName: valueByHeader(cellsByHeader, ["Provider name"]),
    claimAmountBilled: valueByHeader(cellsByHeader, ["Claim amount billed", "Amount billed", "Billed"]),
    claimAmountPaid: valueByHeader(cellsByHeader, ["Claim amount paid", "Amount paid", "Paid"]),
    patientResponsibility: valueByHeader(cellsByHeader, ["Patient responsibility", "Patient resp"]),
  };
}

function extractClaimDetails(args: {
  memberId: string;
  dosSearched: string;
  claimIndex: number;
  resultRowData: BlueShieldResultRowData;
  detailData: BlueShieldDetailData;
  serviceLine: BlueShieldDetailData["serviceLines"][number] | null;
  text: string;
  sourceUrl: string;
}): BlueShieldClaimSummary {
  const { memberId, dosSearched, claimIndex, resultRowData, detailData, serviceLine, text, sourceUrl } = args;
  const detailAmountPaid = detailData.claim.amountPaid;
  const serviceLineAmountPaid = serviceLine?.amountPaid ?? "";
  const serviceLineCoInsurance = serviceLine?.coInsurance ?? "";
  const lineNotes = noteForServiceLine(detailData.claimNotes, serviceLine?.lineNumber ?? "");
  return {
    memberId,
    dosSearched,
    claimIndex,
    listClaimStatusLastModified: resultRowData.claimStatusLastModified,
    claimNumber: resultRowData.claimNumber || firstMatch(text, /Claim\s*(?:Number|#)\s*:?\s*([A-Z0-9-]+)/i),
    claimType: resultRowData.claimType,
    datesOfService: resultRowData.datesOfService,
    eob: resultRowData.eob,
    memberName: resultRowData.memberName,
    listMemberIdSubscriberId: resultRowData.memberIdSubscriberId,
    providerName: resultRowData.providerName,
    claimAmountBilled: resultRowData.claimAmountBilled,
    claimAmountPaid: resultRowData.claimAmountPaid,
    patientResponsibility: resultRowData.patientResponsibility,
    detailDatesOfService: detailData.claim.datesOfService,
    claimReceived: detailData.claim.claimReceived,
    detailProvider: detailData.claim.provider,
    providerNumber: detailData.claim.providerNumber,
    nationalProviderIdentifier: detailData.claim.nationalProviderIdentifier,
    ipaMedGroup: detailData.claim.ipaMedGroup,
    detailAmountBilled: detailData.claim.amountBilled,
    allowedAmount: detailData.claim.allowedAmount,
    detailPatientResponsibility: detailData.claim.patientResponsibility,
    detailAmountPaid,
    checkEftNumber: detailData.payment.checkEftNumber,
    checkEftDate: detailData.payment.checkEftDate,
    checkEftStatus: detailData.payment.checkEftStatus,
    checkEftAmount: detailData.payment.checkEftAmount,
    payeeName: detailData.payment.payeeName,
    payeeAddress: detailData.payment.payeeAddress,
    serviceLineNumber: serviceLine?.lineNumber ?? "",
    serviceLineDatesOfService: serviceLine?.datesOfService ?? "",
    placeOfService: serviceLine?.placeOfService ?? "",
    units: serviceLine?.units ?? "",
    procedureCode: serviceLine?.procedureCode ?? "",
    modifier: serviceLine?.modifier ?? "",
    serviceLineAmountBilled: serviceLine?.amountBilled ?? "",
    serviceLineAllowedAmount: serviceLine?.allowedAmount ?? "",
    serviceLineDeductible: serviceLine?.deductible ?? "",
    serviceLineCopay: serviceLine?.copay ?? "",
    serviceLineCoInsurance,
    serviceLineAmountPaid,
    claimNotes: lineNotes,
    claimStatus: computeClaimStatus({
      detailAmountPaid,
      listAmountPaid: resultRowData.claimAmountPaid,
      serviceLineAmountPaid,
      serviceLineCoInsurance,
      lineNotes,
      hasServiceLine: Boolean(serviceLine),
    }),
    serviceDate: detailData.claim.datesOfService || resultRowData.datesOfService || firstMatch(text, /(?:Service Date|DOS)\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i),
    receivedDate: firstMatch(text, /Received\s*(?:Date)?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i),
    paidDate: firstMatch(text, /Paid\s*(?:Date)?\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i),
    billedAmount: detailData.claim.amountBilled || resultRowData.claimAmountBilled || firstMatch(text, /Billed\s*(?:Amount)?\s*:?\s*(\$?[0-9,]+(?:\.\d{2})?)/i),
    paidAmount: detailData.claim.amountPaid || resultRowData.claimAmountPaid || firstMatch(text, /Paid\s*(?:Amount)?\s*:?\s*(\$?[0-9,]+(?:\.\d{2})?)/i),
    detailsText: text.replace(/\s+/g, " ").trim().slice(0, 30000),
    sourceUrl,
  };
}

async function openClaimFromRow(page: Page, row: Locator, resultRowData: BlueShieldResultRowData): Promise<Page> {
  const beforePages = page.context().pages();
  const clickableTargets = row.locator(blueShieldConfig.selectors.claimOpenTarget);
  const claimNumberTarget = resultRowData.claimNumber
    ? clickableTargets.filter({ hasText: resultRowData.claimNumber }).first()
    : null;
  const claimDetailTarget = row.locator([
    "a[href*='claim' i]",
    "button[aria-label*='claim' i]",
    "[role='button'][aria-label*='claim' i]",
    "a:has-text('Claim')",
    "button:has-text('Claim')",
  ].join(", ")).first();
  const target =
    claimNumberTarget && await claimNumberTarget.count().catch(() => 0) > 0
      ? claimNumberTarget
      : await claimDetailTarget.count().catch(() => 0) > 0
        ? claimDetailTarget
        : clickableTargets.first();
  const popupPromise = page.waitForEvent("popup", { timeout: 5000 }).catch(() => null);
  await target.click();
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    return popup;
  }
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
  const afterPages = page.context().pages();
  return afterPages.find((candidate) => !beforePages.includes(candidate)) ?? page;
}

async function expandFullView(page: Page): Promise<void> {
  const fullView = page.locator([
    "button:has-text('Full view')",
    "a:has-text('Full view')",
    "[role='button']:has-text('Full view')",
  ].join(", ")).first();
  if (!await fullView.isVisible({ timeout: 3000 }).catch(() => false)) {
    return;
  }

  await fullView.click().catch(async () => {
    await fullView.click({ force: true, timeout: 5000 });
  });
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(750);
}

export async function extractAllBlueShieldClaims(options: {
  page: Page;
  workItem: BlueShieldMemberWorkItem;
  dosSearched: string;
  log: (message: string) => Promise<void>;
}): Promise<BlueShieldClaimSummary[]> {
  const { page, workItem, dosSearched, log } = options;
  const claims: BlueShieldClaimSummary[] = [];
  const seenClaimKeys = new Set<string>();
  const requestedKeys = requestedDosKeys(workItem, dosSearched);
  let resultPage = 1;

  while (true) {
    await assertNoSecurityBlock(page);
    const headers = await getResultHeaders(page);
    const rows = page.locator(blueShieldConfig.selectors.resultRows);
    const rowCount = await rows.count();
    await log(`Blue Shield member ${workItem.memberId}: found ${rowCount} result row(s) on page ${resultPage}.`);

    for (let index = 0; index < rowCount; index++) {
      const row = rows.nth(index);
      const rowText = await row.innerText().catch(() => "");
      if (!rowText.trim()) continue;
      const resultRowData = await extractResultRowData(row, headers);
      if (resultRowData.datesOfService && !textMatchesRequestedDos(resultRowData.datesOfService, requestedKeys)) {
        await log(`Blue Shield member ${workItem.memberId}: skipped result claim ${resultRowData.claimNumber || "(no claim number)"} because result DOS ${resultRowData.datesOfService} does not match requested DOS ${Array.from(requestedKeys).join(", ")}.`);
        continue;
      }

      let detailPage: Page | null = null;
      try {
        detailPage = await openClaimFromRow(page, row, resultRowData);
        await assertNoSecurityBlock(detailPage);
        await expandFullView(detailPage);
        const detailText = await detailPage.locator("body").innerText({ timeout: 15000 }).catch(() => rowText);
        const detailData = await extractDetailData(detailPage, detailText || rowText);
        const matchingServiceLines = detailData.serviceLines.filter((serviceLine) => serviceLineMatchesRequestedDos(serviceLine, requestedKeys));
        if (detailData.serviceLines.length && !matchingServiceLines.length) {
          await log(`Blue Shield member ${workItem.memberId}: skipped claim ${resultRowData.claimNumber || "(no claim number)"} because service line DOS values ${detailData.serviceLines.map((line) => line.datesOfService || "(blank)").join(", ")} do not match requested DOS ${Array.from(requestedKeys).join(", ")}.`);
          continue;
        }
        const serviceLines = detailData.serviceLines.length ? matchingServiceLines : [null];
        if (detailData.serviceLines.length) {
          await log(`Blue Shield member ${workItem.memberId}: claim ${resultRowData.claimNumber || "(no claim number)"} extracted ${matchingServiceLines.length} matching service line(s) from ${detailData.serviceLines.length} total service line(s).`);
        } else {
          await log(`Blue Shield member ${workItem.memberId}: claim ${resultRowData.claimNumber || "(no claim number)"} did not expose parsable service lines; writing claim-level fallback. Detail preview: ${serviceLineDebugPreview(detailText || rowText)}`);
        }
        for (const serviceLine of serviceLines) {
          const claim = extractClaimDetails({
            memberId: workItem.memberId,
            dosSearched,
            claimIndex: claims.length + 1,
            resultRowData,
            detailData,
            serviceLine,
            text: detailText || rowText,
            sourceUrl: detailPage.url(),
          });
          const key = claimSummaryKey(claim);
          if (seenClaimKeys.has(key)) {
            await log(`Blue Shield member ${workItem.memberId}: skipped duplicate claim line ${claim.claimNumber || "(no claim number)"} / ${claim.serviceLineNumber || "(no line number)"}.`);
            continue;
          }
          seenClaimKeys.add(key);
          claims.push({ ...claim, claimIndex: claims.length + 1 });
        }
      } finally {
        if (detailPage && detailPage !== page) {
          await detailPage.close().catch(() => {});
        } else {
          await page.goBack({ waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
        }
      }
    }

    const next = page.locator(blueShieldConfig.selectors.nextResultsPage).first();
    if ((await next.count()) === 0 || !await next.isEnabled().catch(() => false)) break;
    await next.click();
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    resultPage++;
  }

  return claims;
}

export const blueShieldClaimExtractionTestHooks = {
  computeClaimStatus,
  noteForServiceLine,
  mergeServiceLineSources,
  parseServiceLinesFromRows,
  parseServiceLinesFromText,
};
