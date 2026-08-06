import type {
  DisplayedPaymentPostingLineItem,
  LineItemMatchOutcome,
  PaymentPostingLineItemInput,
} from "../../types";

export function normalizeCpt(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

export function normalizePatientId(value: unknown): string {
  return String(value ?? "").trim();
}

export function normalizeCurrencyCents(value: unknown): number | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const negative = /^\(.*\)$/.test(text) || /^-/.test(text);
  const cleaned = text.replace(/[,$\s()]/g, "").replace(/^\+|-$/g, "");
  if (!/^-?\d+(\.\d{1,4})?$/.test(cleaned)) return null;
  const numberValue = Number(cleaned);
  if (!Number.isFinite(numberValue)) return null;
  return Math.round(Math.abs(numberValue) * 100) * (negative || numberValue < 0 ? -1 : 1);
}

export function currencyAmountsEqual(left: unknown, right: unknown): boolean {
  const leftCents = normalizeCurrencyCents(left);
  const rightCents = normalizeCurrencyCents(right);
  return leftCents !== null && rightCents !== null && leftCents === rightCents;
}

export function normalizeAdvancedMdDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return formatMmDdYyyy(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const epoch = Date.UTC(1899, 11, 30);
    return formatMmDdYyyy(new Date(epoch + value * 24 * 60 * 60 * 1000));
  }
  const text = String(value ?? "").trim();
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!match) return text;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${year}`;
}

export function findLineItemMatch(
  displayedLineItems: DisplayedPaymentPostingLineItem[],
  input: PaymentPostingLineItemInput,
): LineItemMatchOutcome {
  const targetCpt = normalizeCpt(input.cpt);
  const cptMatches = displayedLineItems.filter((line) => normalizeCpt(line.code) === targetCpt);
  const exactMatches = cptMatches.filter((line) => currencyAmountsEqual(line.charge, input.chargeAmount));

  if (exactMatches.length === 0) {
    return {
      type: "no-match",
      cptMatched: cptMatches.length > 0,
      chargeMatched: displayedLineItems.some((line) => currencyAmountsEqual(line.charge, input.chargeAmount)),
      candidates: cptMatches,
    };
  }

  const deterministic = disambiguateExactMatches(exactMatches, input);
  if (deterministic.length === 1) {
    return {
      type: "unique",
      cptMatched: true,
      chargeMatched: true,
      lineItem: deterministic[0],
    };
  }

  return {
    type: "ambiguous",
    cptMatched: true,
    chargeMatched: true,
    candidates: deterministic,
  };
}

function disambiguateExactMatches(
  matches: DisplayedPaymentPostingLineItem[],
  input: PaymentPostingLineItemInput,
): DisplayedPaymentPostingLineItem[] {
  let candidates = matches;
  candidates = filterByOptionalExact(candidates, input.modifier, (line) => line.modifier);
  candidates = filterByOptionalExact(candidates, input.units, (line) => line.units);
  candidates = filterByOptionalExact(candidates, input.provider, (line) => line.provider);
  return candidates;
}

function filterByOptionalExact(
  candidates: DisplayedPaymentPostingLineItem[],
  wanted: string | undefined,
  read: (line: DisplayedPaymentPostingLineItem) => string | undefined,
): DisplayedPaymentPostingLineItem[] {
  const normalizedWanted = String(wanted ?? "").trim().toLowerCase();
  if (!normalizedWanted) return candidates;
  const filtered = candidates.filter((line) => String(read(line) ?? "").trim().toLowerCase() === normalizedWanted);
  return filtered.length > 0 ? filtered : candidates;
}

function formatMmDdYyyy(date: Date): string {
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

