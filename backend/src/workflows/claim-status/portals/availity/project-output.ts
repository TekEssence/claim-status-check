import type { AvailityInputRow, AvailityOutputRow } from "./types";

type ClaimLineDetail = Record<string, unknown>;

type ClaimDetail = {
  type?: string;
  payerName?: string;
  serviceDate?: string;
  finalizedDate?: string;
  receivedDate?: string;
  claimNumber?: string;
  claimStatus?: string;
  checkNumber?: string;
  checkDate?: string;
  checkAmount?: string;
  paidAmount?: string;
  lines?: ClaimLineDetail[];
};

type WorkflowResult = {
  status?: string;
  summaries?: string[];
  sourceTab?: string;
  matchCount?: number;
  notes?: string;
  details?: ClaimDetail[];
};

function asText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function valueOrBlank(value: unknown): string {
  return asText(value) || "NA";
}

function cleanText(value: unknown): string {
  return asText(value)
    .replace(/\[[^\]]+\]\s*Show\s+(more|less)\.*\s*/gi, "")
    .replace(/\bShow\s+(more|less)\.*\s*/gi, "")
    .replace(/\s*\|\s*/g, " and ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(value: unknown): string {
  return asText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function moneyToNumber(value: unknown): number {
  const numeric = Number(asText(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(numeric) ? numeric : 0;
}

function findInputCpt(row: AvailityInputRow): string {
  for (const [key, value] of Object.entries(row.data)) {
    if (normalizeCode(key) === "CPT" && asText(value)) {
      return asText(value);
    }
  }
  return "";
}

function findMatchingLines(details: ClaimDetail[], inputCpt: string): { detail: ClaimDetail; line: ClaimLineDetail }[] {
  const normalizedInputCpt = normalizeCode(inputCpt);
  if (!normalizedInputCpt) {
    return [];
  }

  const matches: { detail: ClaimDetail; line: ClaimLineDetail }[] = [];
  for (const detail of details) {
    for (const line of detail.lines || []) {
      if (normalizeCode(line.procedureCode) === normalizedInputCpt) {
        matches.push({ detail, line });
      }
    }
  }

  return matches;
}

function linePaidAmount(line: ClaimLineDetail): string {
  return asText(line.paid || line.paidAmount || line.payment || "");
}

function lineDeniedReason(line: ClaimLineDetail): string {
  const remarkCode = asText(line.remarkCode || line.reasonRemarkCode || "");
  const description = cleanText(line.description);
  return [remarkCode, description].filter(Boolean).join(" - ");
}

function renderMedrevenuCptSummary(detail: ClaimDetail, line: ClaimLineDetail, inputCpt: string): string {
  const serviceDate = valueOrBlank(detail.serviceDate);
  const receivedDate = valueOrBlank(detail.receivedDate);
  const finalizedDate = valueOrBlank(detail.finalizedDate);
  const claimNumber = valueOrBlank(detail.claimNumber);
  const procedureCode = valueOrBlank(line.procedureCode || inputCpt);
  const status = asText(detail.type || detail.claimStatus).toLowerCase();

  if (status.includes("denied")) {
    return `DOS ${serviceDate}: Checked Availity portal CPT ${procedureCode} claim received on ${receivedDate} denied on ${finalizedDate} denial reason ${valueOrBlank(lineDeniedReason(line))}. Claim# ${claimNumber}.`;
  }

  if (status.includes("paid") || moneyToNumber(linePaidAmount(line)) > 0) {
    const paidAmount = valueOrBlank(linePaidAmount(line));
    const copay = valueOrBlank(line.copay);
    const coinsurance = valueOrBlank(line.coinsurance);
    const deductible = valueOrBlank(line.deductible);
    const checkNumber = valueOrBlank(detail.checkNumber);
    const checkAmount = valueOrBlank(detail.checkAmount || detail.paidAmount);
    const billedAmount = asText(line.billed) ? ` Billed Amount: ${valueOrBlank(line.billed)}.` : "";
    const allowedAmount = asText(line.allowed) ? ` Allowed Amount: ${valueOrBlank(line.allowed)}.` : "";
    return `DOS ${serviceDate}: Checked Availity portal CPT ${procedureCode} claim received on ${receivedDate} paid on ${finalizedDate} paid amount ${paidAmount} with copay of ${copay}, coinsurance of ${coinsurance}, and deductible of ${deductible} EFT/Check # ${checkNumber}. Claim #: ${claimNumber}. Check Amount: ${checkAmount}.${billedAmount}${allowedAmount}`;
  }

  return `DOS ${serviceDate}: Checked Availity portal CPT ${procedureCode} claim processed on ${finalizedDate} current status ${valueOrBlank(detail.claimStatus || detail.type)}. Claim# ${claimNumber}.`;
}

function applyCommonBotFields(outputRow: AvailityOutputRow, result: WorkflowResult): void {
  outputRow.bot_search_source_tab = result.sourceTab || "";
  outputRow.bot_match_count = String(result.matchCount ?? "");
  outputRow.bot_overall_result = result.status || "";
  outputRow.bot_notes = result.notes || "";
}

export function applyProjectOutputStrategy(options: {
  projectId: string;
  row: AvailityInputRow;
  outputRow: AvailityOutputRow;
  result: WorkflowResult;
  timestamp: string;
}): AvailityOutputRow[] {
  const { projectId, row, outputRow, result, timestamp } = options;
  applyCommonBotFields(outputRow, result);
  outputRow.bot_updated_time = timestamp;

  if (projectId !== "medrevenu" || result.status !== "success") {
    outputRow.bot_updated_claim_status = result.summaries?.[0] || "";
    return [outputRow];
  }

  const details = Array.isArray(result.details) ? result.details : [];
  const inputCpt = findInputCpt(row);
  const matches = findMatchingLines(details, inputCpt);
  if (!matches.length) {
    const reason = inputCpt
      ? `CPT ${inputCpt} was not found in extracted Availity line details.`
      : "Input CPT column is blank or missing for Medrevenu CPT-level output.";
    outputRow.bot_updated_claim_status = result.summaries?.[0] || "";
    outputRow.bot_overall_result = "failed";
    outputRow.bot_notes = [result.notes, reason].filter(Boolean).join("; ");
    return [outputRow];
  }

  outputRow.bot_updated_claim_status = matches
    .map((match) => renderMedrevenuCptSummary(match.detail, match.line, inputCpt))
    .join("\n\n");
  return [outputRow];
}
