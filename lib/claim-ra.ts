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

function getMemberPolicyIdVariants(memberPolicyId: string): string[] {
  const raw = memberPolicyId.replace(/\s+/g, "").trim();
  const variants = new Set<string>();

  if (raw) {
    variants.add(raw);
  }

  const digitsOnly = raw.replace(/\D+/g, "");
  if (digitsOnly) {
    variants.add(digitsOnly);
  }

  if (/^\d{12}$/.test(digitsOnly)) {
    variants.add(`${digitsOnly.slice(0, 10)}-${digitsOnly.slice(10)}`);
  }

  return Array.from(variants);
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

function lineHasMatchingModifier(tokens: string[], procIndex: number, firstMoneyIndex: number, modifiers: string[]): boolean {
  if (modifiers.length === 0) return true;

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
}): RaDetailRecord[] {
  const { text, memberPolicyId, dosDate, cpt, modifiers = [], checkNumber } = options;
  const dosText = formatMmDdYyyy(dosDate);
  const legend = parseExplanationLegend(text);
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const memberPolicyIdVariants = getMemberPolicyIdVariants(memberPolicyId);
  const records: RaDetailRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!memberPolicyIdVariants.some((variant) => variant && lines[i].includes(variant))) continue;

    const candidateLines = lines.slice(i, Math.min(i + 8, lines.length));
    for (let offset = 0; offset < candidateLines.length; offset++) {
      const candidate = candidateLines[offset];
      if (!candidate.includes(dosText) || !candidate.includes(cpt)) continue;
      records.push(...lineToRaRecords(
        collectServiceLineWithReasonContinuations(lines, i + offset),
        checkNumber,
        cpt,
        modifiers,
        legend,
      ));
    }
  }

  return records;
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
}): RaDetailRecord[] {
  return parseRaDetailsFromText({
    text: extractBestTextFromPdfPages(options.pages),
    memberPolicyId: options.memberPolicyId,
    dosDate: options.dosDate,
    cpt: options.cpt,
    modifiers: options.modifiers,
    checkNumber: options.checkNumber,
  });
}
