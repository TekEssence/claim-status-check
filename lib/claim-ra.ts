import { asText, formatMmDdYyyy } from "./claim-dates";

export type PdfTextItem = {
  str: string;
  x: number;
  y: number;
  width: number;
  height?: number;
};

export type PdfTextPage = {
  pageNumber: number;
  width: number;
  height: number;
  rotation?: number;
  items: PdfTextItem[];
};

export type RaDetailRecord = {
  CheckNumber: string;
  RAProcCode: string;
  RAAmountBilled: string;
  RAAmountAllowed: string;
  RACopay: string;
  RACoins: string;
  RADeductAmount: string;
  RANetPaid: string;
  RAStatus: string;
  RAReason: string;
  RADenialReason: string;
};

export type RaLineCandidateSummary = {
  receivedDate: string;
  serviceFromDate: string;
  serviceToDate: string;
  procCode: string;
  modifiers: string[];
};

type SerializedRaRecords = {
  type: "refer_ra_records";
  version: 1;
  records: RaDetailRecord[];
};

const CPT_HEADER_ALIASES = new Set([
  "cpt",
  "cpt code",
  "cptcode",
  "proc",
  "proc code",
  "proccode",
  "procedure",
  "procedure code",
  "procedurecode",
]);

const MODIFIER_HEADER_ALIASES = new Set([
  "mod",
  "mods",
  "modifier",
  "modifiers",
  "modifier 1",
  "modifier 2",
  "modifier 3",
  "modifier 4",
  "mod 1",
  "mod 2",
  "mod 3",
  "mod 4",
  "mod1",
  "mod2",
  "mod3",
  "mod4",
]);

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function getClaimCptValue(row: Record<string, unknown>): string {
  for (const [key, value] of Object.entries(row)) {
    const normalized = normalizeHeader(key);
    if (CPT_HEADER_ALIASES.has(normalized) || CPT_HEADER_ALIASES.has(normalized.replace(/\s+/g, ""))) {
      const cpt = asText(value);
      if (cpt && cpt !== "NaN") {
        return cpt;
      }
    }
  }

  return "";
}

export function getClaimModifierValues(row: Record<string, unknown>): string[] {
  const modifiers: string[] = [];

  for (const [key, value] of Object.entries(row)) {
    const normalized = normalizeHeader(key);
    const compact = normalized.replace(/\s+/g, "");
    const isModifierColumn =
      MODIFIER_HEADER_ALIASES.has(normalized) ||
      MODIFIER_HEADER_ALIASES.has(compact) ||
      /^modifier\s*\d+$/i.test(normalized) ||
      /^mod\s*\d+$/i.test(normalized);

    if (!isModifierColumn) continue;

    const rawValue = asText(value);
    if (!rawValue || rawValue === "NaN") continue;

    rawValue
      .split(/\s+/)
      .map((token) => token.trim().toUpperCase())
      .filter(Boolean)
      .forEach((token) => modifiers.push(token));
  }

  return Array.from(new Set(modifiers));
}

export function serializeRaRecords(records: RaDetailRecord[]): string {
  const payload: SerializedRaRecords = {
    type: "refer_ra_records",
    version: 1,
    records,
  };
  return JSON.stringify(payload);
}

export function parseSerializedRaRecords(value: string): RaDetailRecord[] {
  const text = asText(value);
  if (!text || !text.startsWith("{")) return [];

  try {
    const parsed = JSON.parse(text) as Partial<SerializedRaRecords>;
    if (parsed.type !== "refer_ra_records" || !Array.isArray(parsed.records)) {
      return [];
    }
    return parsed.records.filter((record): record is RaDetailRecord => {
      return !!record && typeof record === "object" && typeof record.RAProcCode === "string";
    });
  } catch {
    return [];
  }
}

function mapStatus(value: string): string {
  const status = value.trim();
  if (/^P$/i.test(status)) return "Paid";
  if (/^D$/i.test(status)) return "Denied";
  return status;
}

function splitReasonCodes(value: string): string[] {
  return value
    .split(/\s+/)
    .map((code) => code.trim())
    .filter(Boolean);
}

function getMemberPolicyIdVariants(memberPolicyId: string, preferLastTwoDashed = false): string[] {
  const raw = memberPolicyId.replace(/\s+/g, "").trim();
  const variants: string[] = [];
  const addVariant = (value: string) => {
    if (value && !variants.includes(value)) {
      variants.push(value);
    }
  };

  const digitsOnly = raw.replace(/\D+/g, "");

  if (preferLastTwoDashed && digitsOnly.length > 2) {
    addVariant(`${digitsOnly.slice(0, -2)}-${digitsOnly.slice(-2)}`);
  } else {
    if (/^\d{10}$/.test(digitsOnly)) {
      addVariant(`${digitsOnly.slice(0, 8)}-${digitsOnly.slice(8)}`);
    }

    if (/^\d{12}$/.test(digitsOnly)) {
      addVariant(`${digitsOnly.slice(0, 10)}-${digitsOnly.slice(10)}`);
    }
  }

  if (raw) {
    addVariant(raw);
  }

  if (digitsOnly) {
    addVariant(digitsOnly);
  }

  return variants;
}

function parseExplanationLegend(text: string): Map<string, string> {
  const legend = new Map<string, string>();
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  let inLegend = false;

  for (const line of lines) {
    if (/Explanation Code Legend/i.test(line)) {
      inLegend = true;
      continue;
    }
    if (!inLegend) continue;
    if (/ST Code Legend/i.test(line)) break;

    const match = line.match(/^([A-Z0-9]{1,12})\s*[-:]?\s+(.+)$/i);
    if (match) {
      legend.set(match[1].toUpperCase(), match[2].trim());
    }
  }

  return legend;
}

function makeDenialReason(code: string, legend: Map<string, string>): string {
  const description = legend.get(code.toUpperCase());
  return description ? `${code} - ${description}` : code;
}

function isMoneyToken(value: string): boolean {
  const normalized = value.replace(/^\$/, "");
  return /^-?\d{1,3}(?:,\d{3})*(?:\.\d{2})$|^-?\d+\.\d{2}$/.test(normalized);
}

function cleanMoneyToken(value: string): string {
  return value.replace(/^\$/, "");
}

function getAmountOffset(tokens: string[], procIndex: number, moneyTokens: Array<{ token: string; index: number }>): number {
  if (moneyTokens.length < 8) return 0;

  const tokenBeforeFirstMoney = tokens[moneyTokens[0].index - 1] ?? "";
  const hasIntegerQtyBeforeAmounts =
    /^\d+$/.test(tokenBeforeFirstMoney) &&
    (moneyTokens[0].token.startsWith("$") || moneyTokens[0].index - 1 > procIndex + 1);
  return hasIntegerQtyBeforeAmounts ? 0 : 1;
}

function hasDate(value: string): boolean {
  return /^\d{2}\/\d{2}\/\d{4}$/.test(value);
}

function toUtcTime(value: string): number | null {
  if (!hasDate(value)) return null;
  const [month, day, year] = value.split("/").map(Number);
  return Date.UTC(year, month - 1, day);
}

function serviceDateMatches(dosText: string, serviceFromDate: string, serviceToDate: string): boolean {
  const dosTime = toUtcTime(dosText);
  const fromTime = toUtcTime(serviceFromDate);
  const toTime = toUtcTime(serviceToDate);

  if (dosTime === null || fromTime === null || toTime === null) {
    return false;
  }

  return dosTime >= fromTime && dosTime <= toTime;
}

function isRaServiceLine(line: string): boolean {
  const tokens = line.replace(/\s+/g, " ").trim().split(" ");
  const dateCount = tokens.filter(hasDate).length;
  const moneyCount = tokens.filter(isMoneyToken).length;
  return dateCount >= 2 && moneyCount >= 5;
}

function isRaContinuationStopLine(line: string): boolean {
  return (
    isRaServiceLine(line) ||
    /^\d{14}\b/.test(line) ||
    /^(Patient Acct\.|Claim Totals|Member Totals|Provider Totals|Explanation Code Legend|ST Code Legend)/i.test(line)
  );
}

function collectServiceLineWithReasonContinuations(lines: string[], startIndex: number): string {
  const collected = [lines[startIndex]];

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isRaContinuationStopLine(line)) break;
    collected.push(line);
  }

  return collected.join(" ");
}

/*
###New Code -Start###
*/
function getModifierTokens(tokens: string[], procIndex: number, firstMoneyIndex: number): string[] {
  const modifierTokens = tokens
    .slice(procIndex + 1, firstMoneyIndex)
    .map((token) => token.trim().toUpperCase())
    .filter(Boolean);

  if (modifierTokens.length > 0) {
    const lastToken = modifierTokens[modifierTokens.length - 1];
    if (/^\d+(?:\.\d+)?$/.test(lastToken)) {
      modifierTokens.pop();
    }
  }

  return modifierTokens;
}

function parseRaLineCandidateSummary(line: string): RaLineCandidateSummary | null {
  const tokens = line.replace(/\s+/g, " ").trim().split(" ");
  const moneyTokens = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => isMoneyToken(token));

  if (moneyTokens.length < 7) return null;

  const firstMoneyIndex = moneyTokens[0]?.index ?? -1;
  if (firstMoneyIndex <= 0) return null;

  const dateIndexesBeforeProc = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token, index }) => index < firstMoneyIndex && hasDate(token));

  if (dateIndexesBeforeProc.length < 3) return null;

  const lastThreeDateEntries = dateIndexesBeforeProc.slice(-3);
  const [receivedDate, serviceFromDate, serviceToDate] = lastThreeDateEntries.map(({ token }) => token);
  const lastDateIndex = lastThreeDateEntries[lastThreeDateEntries.length - 1].index;

  let procIndex = lastDateIndex + 1;
  const tokenAfterLastDate = tokens[procIndex] ?? "";
  const nextTokenAfterLastDate = tokens[procIndex + 1] ?? "";

  if (!/^\d{4,5}[A-Z0-9]*$/i.test(tokenAfterLastDate) && /^\d{4,5}[A-Z0-9]*$/i.test(nextTokenAfterLastDate)) {
    procIndex += 1;
  }

  if (procIndex >= firstMoneyIndex) return null;

  return {
    receivedDate,
    serviceFromDate,
    serviceToDate,
    procCode: tokens[procIndex],
    modifiers: getModifierTokens(tokens, procIndex, moneyTokens[0].index),
  };
}

function formatRaLineCandidateSummary(candidate: RaLineCandidateSummary): string {
  const modifiersText = candidate.modifiers.length > 0 ? candidate.modifiers.join(" ") : "(none)";
  return `Received ${candidate.receivedDate}, Service From ${candidate.serviceFromDate}, Service To ${candidate.serviceToDate}, Proc ${candidate.procCode}, Modifiers ${modifiersText}`;
}
/*
###New Code - End###
*/

function lineHasMatchingModifier(tokens: string[], procIndex: number, firstMoneyIndex: number, modifiers: string[]): boolean {
  if (modifiers.length === 0) return true;

  const modifierTokens = getModifierTokens(tokens, procIndex, firstMoneyIndex);

  const modifierSet = new Set(modifierTokens);
  return modifiers.some((modifier) => modifierSet.has(modifier.toUpperCase()));
}

function lineToRaRecords(line: string, checkNumber: string, cpt: string, modifiers: string[], legend: Map<string, string>): RaDetailRecord[] {
  const tokens = line.replace(/\s+/g, " ").trim().split(" ");
  const procIndex = tokens.findIndex((token) => token === cpt);
  if (procIndex === -1) return [];

  const dateCountBeforeProc = tokens.slice(0, procIndex).filter(hasDate).length;
  if (dateCountBeforeProc < 2) return [];

  const moneyTokens = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ index, token }) => index > procIndex && isMoneyToken(token));

  if (moneyTokens.length < 7) return [];

  const amountOffset = getAmountOffset(tokens, procIndex, moneyTokens);
  const firstMoneyIndex = moneyTokens[amountOffset].index;
  if (!lineHasMatchingModifier(tokens, procIndex, firstMoneyIndex, modifiers)) return [];
  const lastMoneyIndex = moneyTokens[Math.min(amountOffset + 6, moneyTokens.length - 1)].index;
  const statusIndex = tokens.findIndex((token, index) => index > lastMoneyIndex && /^[A-Z]$/i.test(token));
  const reasonText = statusIndex === -1 ? "" : tokens.slice(statusIndex + 1).join(" ");
  const reasons = splitReasonCodes(reasonText);
  const joinedReasonCodes = reasons.join(", ");
  const joinedDenialReasons = reasons.map((reasonCode) => makeDenialReason(reasonCode, legend)).join(", ");

  return [{
    CheckNumber: checkNumber,
    RAProcCode: tokens[procIndex],
    RAAmountBilled: cleanMoneyToken(tokens[firstMoneyIndex]),
    RAAmountAllowed: cleanMoneyToken(moneyTokens[amountOffset + 1]?.token ?? ""),
    RACopay: cleanMoneyToken(moneyTokens[amountOffset + 3]?.token ?? ""),
    RACoins: cleanMoneyToken(moneyTokens[amountOffset + 4]?.token ?? ""),
    RADeductAmount: cleanMoneyToken(moneyTokens[amountOffset + 5]?.token ?? ""),
    RANetPaid: cleanMoneyToken(moneyTokens[amountOffset + 6]?.token ?? ""),
    RAStatus: statusIndex === -1 ? "" : mapStatus(tokens[statusIndex]),
    RAReason: joinedReasonCodes,
    RADenialReason: joinedDenialReasons,
  }];
}

export function parseRaDetailsFromText(options: {
  text: string;
  memberPolicyId: string;
  dosDate: Date;
  cpt: string;
  modifiers?: string[];
  checkNumber: string;
  preferLastTwoDashedMemberId?: boolean;
}): RaDetailRecord[] {
  const { text, memberPolicyId, dosDate, cpt, modifiers = [], checkNumber, preferLastTwoDashedMemberId = false } = options;
  const dosText = formatMmDdYyyy(dosDate);
  const legend = parseExplanationLegend(text);
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const memberPolicyIdVariants = getMemberPolicyIdVariants(memberPolicyId, preferLastTwoDashedMemberId);
  const records: RaDetailRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!memberPolicyIdVariants.some((variant) => variant && lines[i].includes(variant))) continue;

    const candidateLines = lines.slice(i, Math.min(i + 8, lines.length));
    for (let offset = 0; offset < candidateLines.length; offset++) {
      const candidate = collectServiceLineWithReasonContinuations(lines, i + offset);
      const parsedCandidate = parseRaLineCandidateSummary(candidate);
      if (!parsedCandidate) continue;
      if (parsedCandidate.procCode !== cpt) continue;
      if (!serviceDateMatches(dosText, parsedCandidate.serviceFromDate, parsedCandidate.serviceToDate)) continue;
      records.push(...lineToRaRecords(candidate, checkNumber, cpt, modifiers, legend));
    }
  }

  return records;
}

export function describeRaMatchFailureFromText(options: {
  text: string;
  memberPolicyId: string;
  dosDate?: Date;
  cpt?: string;
  modifiers?: string[];
  preferLastTwoDashedMemberId?: boolean;
}): string {
  const { text, memberPolicyId, dosDate, cpt, modifiers = [], preferLastTwoDashedMemberId = false } = options;
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const memberPolicyIdVariants = getMemberPolicyIdVariants(memberPolicyId, preferLastTwoDashedMemberId);
  const dosText = dosDate ? formatMmDdYyyy(dosDate) : "";
  const summaries: string[] = [];
  const availableDos = new Set<string>();
  const availableCpts = new Set<string>();
  const availableModifiers = new Set<string>();
  let memberSectionFound = false;
  let structuredLineFound = false;
  let matchingDosFound = false;
  let matchingCptFound = false;

  for (let i = 0; i < lines.length; i++) {
    if (!memberPolicyIdVariants.some((variant) => variant && lines[i].includes(variant))) continue;
    memberSectionFound = true;

    const candidateLines = lines.slice(i, Math.min(i + 8, lines.length));
    for (let offset = 0; offset < candidateLines.length; offset++) {
      const candidate = collectServiceLineWithReasonContinuations(lines, i + offset);
      const parsedCandidate = parseRaLineCandidateSummary(candidate);
      if (!parsedCandidate) continue;
      structuredLineFound = true;

      const formatted = formatRaLineCandidateSummary(parsedCandidate);
      if (!summaries.includes(formatted)) {
        summaries.push(formatted);
      }

      const dosLabel = `${parsedCandidate.serviceFromDate}${parsedCandidate.serviceToDate !== parsedCandidate.serviceFromDate ? ` to ${parsedCandidate.serviceToDate}` : ""}`;
      availableDos.add(dosLabel);

      if (!dosText || serviceDateMatches(dosText, parsedCandidate.serviceFromDate, parsedCandidate.serviceToDate)) {
        matchingDosFound = true;
        availableCpts.add(parsedCandidate.procCode);
      }

      if ((!dosText || serviceDateMatches(dosText, parsedCandidate.serviceFromDate, parsedCandidate.serviceToDate)) && parsedCandidate.procCode === cpt) {
        matchingCptFound = true;
        parsedCandidate.modifiers.forEach((modifier) => availableModifiers.add(modifier));
      }
    }
  }

  if (!memberSectionFound) {
    return `Claim/member not found in RA for Member ID ${memberPolicyId}.`;
  }

  if (!structuredLineFound) {
    return `Claim/member found for Member ID ${memberPolicyId}, but no structured RA service lines were found under that member section.`;
  }

  if (dosText && !matchingDosFound) {
    return `Claim/member found, but DOS ${dosText} not found. Available DOS: ${Array.from(availableDos).join(", ")}.`;
  }

  if (cpt && !matchingCptFound) {
    return `Claim/member and DOS found, but CPT ${cpt} not found. Available CPT: ${Array.from(availableCpts).join(", ")}.`;
  }

  if (modifiers.length > 0) {
    const normalizedRequestedModifiers = modifiers.map((modifier) => modifier.toUpperCase());
    const hasMatchingModifier = normalizedRequestedModifiers.some((modifier) => availableModifiers.has(modifier));
    if (!hasMatchingModifier) {
      const availableModifierText = availableModifiers.size > 0 ? Array.from(availableModifiers).join(", ") : "(none)";
      return `Claim/member, DOS, and CPT found, but modifiers ${normalizedRequestedModifiers.join(", ")} not found. Available modifiers: ${availableModifierText}.`;
    }
  }

  return `Claim/member found, but no exact RA line match was found. Candidate lines: ${summaries.join(" | ")}`;
}

function groupItemsIntoText(items: PdfTextItem[]): string {
  const sorted = [...items]
    .filter((item) => item.str.trim())
    .sort((a, b) => Math.abs(a.y - b.y) > 3 ? a.y - b.y : a.x - b.x);

  const lines: PdfTextItem[][] = [];
  for (const item of sorted) {
    const current = lines[lines.length - 1];
    if (!current || Math.abs(current[0].y - item.y) > 3) {
      lines.push([item]);
    } else {
      current.push(item);
    }
  }

  return lines
    .map((line) => line.sort((a, b) => a.x - b.x).map((item) => item.str).join(" ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function rotateItems(page: PdfTextPage, rotation: 0 | 90 | 180 | 270): PdfTextItem[] {
  return page.items.map((item) => {
    if (rotation === 90) {
      return { ...item, x: page.height - item.y, y: item.x };
    }
    if (rotation === 180) {
      return { ...item, x: page.width - item.x, y: page.height - item.y };
    }
    if (rotation === 270) {
      return { ...item, x: item.y, y: page.width - item.x };
    }
    return item;
  });
}

function scoreRaText(text: string): number {
  let score = 0;
  if (/Amount\s+Billed/i.test(text)) score += 2;
  if (/Amount\s+Allowed/i.test(text)) score += 2;
  if (/Deduct\s+Amount/i.test(text)) score += 2;
  if (/Net\s+Paid/i.test(text)) score += 2;
  if (/Explanation\s+Code\s+Legend/i.test(text)) score += 3;
  if (/ST\s+Code\s+Legend/i.test(text)) score += 1;
  return score;
}

export function extractBestTextFromPdfPages(pages: PdfTextPage[]): string {
  return pages.map((page) => {
    const rotations: Array<0 | 90 | 180 | 270> = [0, 90, 180, 270];
    const candidates = rotations.map((rotation) => {
      const text = groupItemsIntoText(rotateItems(page, rotation));
      return { text, score: scoreRaText(text) };
    });
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.text ?? "";
  }).join("\n");
}

export function parseRaDetailsFromPdfPages(options: {
  pages: PdfTextPage[];
  memberPolicyId: string;
  dosDate: Date;
  cpt: string;
  modifiers?: string[];
  checkNumber: string;
  preferLastTwoDashedMemberId?: boolean;
}): RaDetailRecord[] {
  return parseRaDetailsFromText({
    text: extractBestTextFromPdfPages(options.pages),
    memberPolicyId: options.memberPolicyId,
    dosDate: options.dosDate,
    cpt: options.cpt,
    modifiers: options.modifiers,
    checkNumber: options.checkNumber,
    preferLastTwoDashedMemberId: options.preferLastTwoDashedMemberId,
  });
}

export function describeRaMatchFailureFromPdfPages(options: {
  pages: PdfTextPage[];
  memberPolicyId: string;
  dosDate?: Date;
  cpt?: string;
  modifiers?: string[];
  preferLastTwoDashedMemberId?: boolean;
}): string {
  return describeRaMatchFailureFromText({
    text: extractBestTextFromPdfPages(options.pages),
    memberPolicyId: options.memberPolicyId,
    dosDate: options.dosDate,
    cpt: options.cpt,
    modifiers: options.modifiers,
    preferLastTwoDashedMemberId: options.preferLastTwoDashedMemberId,
  });
}
