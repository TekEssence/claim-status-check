import { asText, formatMmDdYyyy } from "./dates";

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

type RotationDegrees = 0 | 90 | 180 | 270;

export type RaDetailRecord = {
  CheckNumber: string;
  RACheckAmount: string;
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
  claimNumber?: string;
  receivedDate: string;
  serviceFromDate: string;
  serviceToDate: string;
  revCode?: string;
  procCode: string;
  modifiers: string[];
  qty?: string;
};

type RaLineParseDebug = {
  line: string;
  parsed: Partial<RaLineCandidateSummary>;
  missing: string[];
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

function extractRaHeaderCheckAmount(text: string): string {
  const match = text.match(/Check Amount:\s*\$?([0-9,]+\.\d{2})/i);
  return match ? match[1].replace(/^\$/, "").trim() : "";
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

/*
###New Code -Start###
*/
function normalizeMemberIdText(value: string): string {
  return value.replace(/\s+/g, "").replace(/\D+/g, "");
}

function extractMemberIdsFromLine(line: string): string[] {
  const matches = line.match(/\b\d[\d\s-]{5,}\d\b/g) ?? [];
  return Array.from(new Set(matches.map((match) => match.replace(/\s+/g, "").trim()).filter(Boolean)));
}

function lineMatchesMemberPolicyId(line: string, memberPolicyIdVariants: string[]): boolean {
  const normalizedLine = line.replace(/\s*-\s*/g, "-");

  if (memberPolicyIdVariants.some((variant) => variant && normalizedLine.includes(variant))) {
    return true;
  }

  const targetDigits = new Set(
    memberPolicyIdVariants
      .map((variant) => normalizeMemberIdText(variant))
      .filter(Boolean),
  );

  const lineMemberIds = extractMemberIdsFromLine(normalizedLine);
  return lineMemberIds.some((memberId) => targetDigits.has(normalizeMemberIdText(memberId)));
}
/*
###New Code - End###
*/

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

function isClaimNumberToken(value: string): boolean {
  const compact = value.replace(/[^A-Z0-9]/gi, "");
  return compact.length > 5 && /[A-Z0-9]/i.test(compact);
}

function isIntegerLikeToken(value: string): boolean {
  return /^\d+$/.test(value);
}

function isProcedureCodeToken(value: string): boolean {
  return /^\d{4,5}[A-Z0-9]*$/i.test(value);
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

function isRaSectionStopLine(line: string): boolean {
  return /^(Claim Totals|Member Totals|Provider Totals|Explanation Code Legend|ST Code Legend)/i.test(line);
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

type StructuredRaLineLayout = {
  claimNumber?: string;
  lineVerToken?: string;
  receivedIndex: number;
  serviceFromIndex: number;
  serviceToIndex: number;
  revIndex?: number;
  procIndex: number;
  qtyIndex?: number;
  firstMoneyIndex: number;
};

function debugParseRaLineStructure(line: string): RaLineParseDebug {
  const tokens = line.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const parsed: Partial<RaLineCandidateSummary> = {};
  const missing: string[] = [];

  let claimTokenIndex = -1;
  for (let index = 0; index < tokens.length; index++) {
    if (
      isClaimNumberToken(tokens[index] ?? "") &&
      isIntegerLikeToken(tokens[index + 1] ?? "") &&
      hasDate(tokens[index + 2] ?? "") &&
      hasDate(tokens[index + 3] ?? "") &&
      hasDate(tokens[index + 4] ?? "")
    ) {
      claimTokenIndex = index;
      parsed.claimNumber = tokens[index];
      break;
    }
  }

  if (claimTokenIndex === -1) {
    missing.push("claim number + line/ver + 3 continuous dates");
    const dateIndexes = tokens.map((token, index) => ({ token, index })).filter(({ token }) => hasDate(token));
    if (dateIndexes.length >= 3) {
      const [receivedDate, serviceFromDate, serviceToDate] = dateIndexes.slice(0, 3).map(({ token }) => token);
      parsed.receivedDate = receivedDate;
      parsed.serviceFromDate = serviceFromDate;
      parsed.serviceToDate = serviceToDate;
    }
    return { line, parsed, missing };
  }

  parsed.receivedDate = tokens[claimTokenIndex + 2];
  parsed.serviceFromDate = tokens[claimTokenIndex + 3];
  parsed.serviceToDate = tokens[claimTokenIndex + 4];

  let procIndex = claimTokenIndex + 5;
  if (isProcedureCodeToken(tokens[procIndex + 1] ?? "")) {
    parsed.revCode = tokens[procIndex];
    procIndex += 1;
  }

  if (!isProcedureCodeToken(tokens[procIndex] ?? "")) {
    missing.push("proc code after dates");
    return { line, parsed, missing };
  }

  parsed.procCode = tokens[procIndex];
  const moneyTokens = tokens.map((token, index) => ({ token, index })).filter(({ token }) => isMoneyToken(token));
  const firstMoneyIndex = moneyTokens[0]?.index ?? tokens.length;
  parsed.modifiers = getModifierTokens(tokens, procIndex, firstMoneyIndex);
  parsed.qty = tokens.slice(procIndex + 1, firstMoneyIndex).find((token) => /^\d+(?:\.\d+)?$/.test(token));

  return { line, parsed, missing };
}

function findStructuredRaLineLayout(tokens: string[], firstMoneyIndex: number): StructuredRaLineLayout | null {
  for (let index = 0; index <= Math.max(0, firstMoneyIndex - 5); index++) {
    if (
      isClaimNumberToken(tokens[index] ?? "") &&
      isIntegerLikeToken(tokens[index + 1] ?? "") &&
      hasDate(tokens[index + 2] ?? "") &&
      hasDate(tokens[index + 3] ?? "") &&
      hasDate(tokens[index + 4] ?? "")
    ) {
      let procIndex = index + 5;
      let revIndex: number | undefined;
      if (isProcedureCodeToken(tokens[procIndex + 1] ?? "")) {
        revIndex = procIndex;
        procIndex += 1;
      }
      if (!isProcedureCodeToken(tokens[procIndex] ?? "") || procIndex >= firstMoneyIndex) continue;

      let qtyIndex: number | undefined;
      for (let i = procIndex + 1; i < firstMoneyIndex; i++) {
        if (/^\d+(?:\.\d+)?$/.test(tokens[i] ?? "")) {
          qtyIndex = i;
        }
      }

      return {
        claimNumber: tokens[index],
        lineVerToken: tokens[index + 1],
        receivedIndex: index + 2,
        serviceFromIndex: index + 3,
        serviceToIndex: index + 4,
        revIndex,
        procIndex,
        qtyIndex,
        firstMoneyIndex,
      };
    }
  }

  for (let index = 0; index <= Math.max(0, firstMoneyIndex - 4); index++) {
    if (
      isIntegerLikeToken(tokens[index] ?? "") &&
      hasDate(tokens[index + 1] ?? "") &&
      hasDate(tokens[index + 2] ?? "") &&
      hasDate(tokens[index + 3] ?? "")
    ) {
      let procIndex = index + 4;
      let revIndex: number | undefined;
      if (isProcedureCodeToken(tokens[procIndex + 1] ?? "")) {
        revIndex = procIndex;
        procIndex += 1;
      }
      if (!isProcedureCodeToken(tokens[procIndex] ?? "") || procIndex >= firstMoneyIndex) continue;

      let qtyIndex: number | undefined;
      for (let i = procIndex + 1; i < firstMoneyIndex; i++) {
        if (/^\d+(?:\.\d+)?$/.test(tokens[i] ?? "")) {
          qtyIndex = i;
        }
      }

      return {
        lineVerToken: tokens[index],
        receivedIndex: index + 1,
        serviceFromIndex: index + 2,
        serviceToIndex: index + 3,
        revIndex,
        procIndex,
        qtyIndex,
        firstMoneyIndex,
      };
    }
  }

  return null;
}

function getMemberSectionCandidateIndexes(lines: string[], memberLineIndex: number): number[] {
  const indexes: number[] = [];
  for (let index = memberLineIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (isRaSectionStopLine(line)) break;
    indexes.push(index);
  }
  return indexes;
}

function parseRaLineCandidateSummary(line: string): RaLineCandidateSummary | null {
  const tokens = line.replace(/\s+/g, " ").trim().split(" ");
  const moneyTokens = tokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => isMoneyToken(token));
  const firstMoneyIndex = moneyTokens[0]?.index ?? tokens.length;
  const layout = findStructuredRaLineLayout(tokens, firstMoneyIndex);
  if (!layout) return null;

  return {
    claimNumber: layout.claimNumber,
    receivedDate: tokens[layout.receivedIndex],
    serviceFromDate: tokens[layout.serviceFromIndex],
    serviceToDate: tokens[layout.serviceToIndex],
    revCode: layout.revIndex !== undefined ? tokens[layout.revIndex] : undefined,
    procCode: tokens[layout.procIndex],
    modifiers: getModifierTokens(tokens, layout.procIndex, firstMoneyIndex),
    qty: layout.qtyIndex !== undefined ? tokens[layout.qtyIndex] : undefined,
  };
}

function formatRaLineCandidateSummary(candidate: RaLineCandidateSummary): string {
  const modifiersText = candidate.modifiers.length > 0 ? candidate.modifiers.join(" ") : "(none)";
  const claimText = candidate.claimNumber ? `Claim ${candidate.claimNumber}, ` : "";
  const revText = candidate.revCode ? `, Rev ${candidate.revCode}` : "";
  const qtyText = candidate.qty ? `, Qty ${candidate.qty}` : "";
  return `${claimText}Received ${candidate.receivedDate}, Service From ${candidate.serviceFromDate}, Service To ${candidate.serviceToDate}${revText}, Proc ${candidate.procCode}, Modifiers ${modifiersText}${qtyText}`;
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

function lineToRaRecords(
  line: string,
  checkNumber: string,
  raCheckAmount: string,
  cpt: string,
  modifiers: string[],
  legend: Map<string, string>,
): RaDetailRecord[] {
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
    RACheckAmount: raCheckAmount,
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
  const raCheckAmount = extractRaHeaderCheckAmount(text);
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter(Boolean);
  const memberPolicyIdVariants = getMemberPolicyIdVariants(memberPolicyId, preferLastTwoDashedMemberId);
  const records: RaDetailRecord[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (!lineMatchesMemberPolicyId(lines[i], memberPolicyIdVariants)) continue;
    const candidateIndexes = getMemberSectionCandidateIndexes(lines, i);
    for (const candidateIndex of candidateIndexes) {
      const candidate = collectServiceLineWithReasonContinuations(lines, candidateIndex);
      const parsedCandidate = parseRaLineCandidateSummary(candidate);
      if (!parsedCandidate) continue;
      if (parsedCandidate.procCode !== cpt) continue;
      if (!serviceDateMatches(dosText, parsedCandidate.serviceFromDate, parsedCandidate.serviceToDate)) continue;
      records.push(...lineToRaRecords(candidate, checkNumber, raCheckAmount, cpt, modifiers, legend));
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
  const availableMemberIds = new Set<string>();
  let memberSectionFound = false;
  let structuredLineFound = false;
  let matchingDosFound = false;
  let matchingCptFound = false;
  let firstUnparsedDebug: RaLineParseDebug | null = null;
  let matchedMemberLine: string | null = null;

  lines.forEach((line) => {
    extractMemberIdsFromLine(line).forEach((memberId) => availableMemberIds.add(memberId));
  });

  for (let i = 0; i < lines.length; i++) {
    if (!lineMatchesMemberPolicyId(lines[i], memberPolicyIdVariants)) continue;
    memberSectionFound = true;
    if (!matchedMemberLine) {
      matchedMemberLine = lines[i];
    }

    const candidateIndexes = getMemberSectionCandidateIndexes(lines, i);
    for (const candidateIndex of candidateIndexes) {
      const candidate = collectServiceLineWithReasonContinuations(lines, candidateIndex);
      const parsedCandidate = parseRaLineCandidateSummary(candidate);
      if (!parsedCandidate) {
        if (!firstUnparsedDebug) {
          firstUnparsedDebug = debugParseRaLineStructure(lines[candidateIndex]);
        }
        continue;
      }
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
    const availableMemberIdsText = availableMemberIds.size > 0 ? Array.from(availableMemberIds).join(", ") : "(none)";
    return `Claim/member not found in RA for Member ID ${memberPolicyId}. Available member IDs: ${availableMemberIdsText}.`;
  }

  if (!structuredLineFound) {
    if (firstUnparsedDebug) {
      const parsedBits = [
        firstUnparsedDebug.parsed.claimNumber ? `Claim ${firstUnparsedDebug.parsed.claimNumber}` : "",
        firstUnparsedDebug.parsed.receivedDate ? `Received ${firstUnparsedDebug.parsed.receivedDate}` : "",
        firstUnparsedDebug.parsed.serviceFromDate ? `Service From ${firstUnparsedDebug.parsed.serviceFromDate}` : "",
        firstUnparsedDebug.parsed.serviceToDate ? `Service To ${firstUnparsedDebug.parsed.serviceToDate}` : "",
        firstUnparsedDebug.parsed.procCode ? `Proc ${firstUnparsedDebug.parsed.procCode}` : "",
      ].filter(Boolean).join(", ");
      const missingBits = firstUnparsedDebug.missing.join(", ") || "(none)";
      return `Claim/member found for Member ID ${memberPolicyId}. Member line: ${matchedMemberLine ?? "(unknown)"}. Immediate below line: ${firstUnparsedDebug.line}. Parsed: ${parsedBits || "(nothing)"}. Not parsed: ${missingBits}.`;
    }
    return `Claim/member found for Member ID ${memberPolicyId}. Member line: ${matchedMemberLine ?? "(unknown)"}. No structured RA service lines were found under that member section.`;
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

function rotateItems(page: PdfTextPage, rotation: RotationDegrees): PdfTextItem[] {
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

export function extractBestTextFromPdfPages(pages: PdfTextPage[], forcedRotation?: RotationDegrees): string {
  return pages.map((page) => {
    const rotations: RotationDegrees[] = forcedRotation !== undefined ? [forcedRotation] : [0, 90, 180, 270];
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
  forcedTextRotation?: RotationDegrees;
}): RaDetailRecord[] {
  return parseRaDetailsFromText({
    text: extractBestTextFromPdfPages(options.pages, options.forcedTextRotation),
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
  forcedTextRotation?: RotationDegrees;
}): string {
  return describeRaMatchFailureFromText({
    text: extractBestTextFromPdfPages(options.pages, options.forcedTextRotation),
    memberPolicyId: options.memberPolicyId,
    dosDate: options.dosDate,
    cpt: options.cpt,
    modifiers: options.modifiers,
    preferLastTwoDashedMemberId: options.preferLastTwoDashedMemberId,
  });
}
