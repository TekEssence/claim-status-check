import type {
  AvailityClaimDetail,
  AvailityNormalizedClaimDetail,
  AvailityNormalizedServiceLine,
  AvailityNormalizedSummaryRow,
  AvailityServiceLine,
  AvailitySummaryItem,
} from "./types";

function asText(value: unknown): string {
  return value === undefined || value === null ? "" : String(value).trim();
}

function amountValue(amounts: Record<string, { value?: string }> | undefined, key: string): string {
  return asText(amounts?.[key]?.value);
}

function formatMoney(value: unknown): string {
  const text = asText(value);
  if (!text) return "";
  const numeric = Number(text.replace(/[$,\s]/g, ""));
  if (!Number.isFinite(numeric)) return text;
  return `$${numeric.toFixed(2)}`;
}

function formatDate(value: unknown): string {
  const text = asText(value);
  if (!text) return "";
  const datePart = text.split("T")[0];
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (!match) return text;
  return `${match[2]}/${match[3]}/${match[1]}`;
}

function patientName(item: AvailitySummaryItem | AvailityClaimDetail): string {
  const lastName = asText(item.patient?.lastName || item.subscriber?.lastName);
  const firstName = asText(item.patient?.firstName || item.subscriber?.firstName);
  return [lastName, firstName].filter(Boolean).join(", ");
}

function joinRemarkCodes(remarks: AvailityServiceLine["remarks"]): string {
  return (remarks || [])
    .map((remark) => asText(remark.code))
    .filter(Boolean)
    .join(", ");
}

function joinRemarkDescriptions(remarks: AvailityServiceLine["remarks"]): string {
  return (remarks || [])
    .map((remark) => {
      const code = asText(remark.code);
      const reason = asText(remark.reason);
      return [code, reason].filter(Boolean).join(": ");
    })
    .filter(Boolean)
    .join(" and ");
}

export function normalizeSummaryItems(items: AvailitySummaryItem[] = []): AvailityNormalizedSummaryRow[] {
  return items.map((item, index) => ({
    claimNumber: asText(item.claimNumber),
    status: asText(item.status),
    serviceDate: formatDate(item.fromDate),
    toDate: formatDate(item.toDate),
    billedAmount: formatMoney(amountValue(item.amounts, "BILLED")),
    insurancePaidAmount: formatMoney(amountValue(item.amounts, "INSURANCE_TOTAL_PAID")),
    memberId: asText(item.subscriber?.memberId || item.patient?.memberId),
    patientName: patientName(item),
    patientAccountNumber: asText(item.patient?.accountNumber),
    claimIndex: index,
    raw: item,
  }));
}

export function normalizeServiceLine(line: AvailityServiceLine): AvailityNormalizedServiceLine {
  return {
    lineNumber: asText(line.lineNumber),
    procedureCode: asText(line.procedureCode || line.serviceCode),
    procedureDescription: asText(line.procedureCodeDescription),
    status: asText(line.status),
    serviceDate: formatDate(line.fromDate),
    toDate: formatDate(line.toDate),
    effectiveDate: formatDate(line.effectiveDate),
    billed: formatMoney(amountValue(line.amounts, "BILLED")),
    allowed: formatMoney(amountValue(line.amounts, "ALLOWED")),
    paid: formatMoney(amountValue(line.amounts, "INSURANCE_TOTAL_PAID")),
    copay: formatMoney(amountValue(line.amounts, "COPAY")),
    coinsurance: formatMoney(amountValue(line.amounts, "COINSURANCE")),
    deductible: formatMoney(amountValue(line.amounts, "DEDUCTIBLE")),
    remarkCode: joinRemarkCodes(line.remarks),
    description: joinRemarkDescriptions(line.remarks),
    remarks: (line.remarks || []).map((remark) => ({
      code: asText(remark.code),
      reason: asText(remark.reason),
    })),
    raw: line,
  };
}

export function normalizeClaimDetail(claim: AvailityClaimDetail): AvailityNormalizedClaimDetail {
  const remittance = claim.remittanceInfo?.[0] || {};
  return {
    type: asText(claim.status).toLowerCase(),
    claimNumber: asText(claim.claimNumber),
    claimStatus: asText(claim.status),
    serviceDate: formatDate(claim.fromDate),
    toDate: formatDate(claim.toDate),
    receivedDate: formatDate(claim.receivedDate),
    finalizedDate: formatDate(claim.effectiveDate),
    checkNumber: asText(remittance.checkNumber),
    checkDate: formatDate(remittance.checkDate),
    checkAmount: formatMoney(remittance.checkAmount),
    paidAmount: formatMoney(amountValue(claim.amounts, "INSURANCE_TOTAL_PAID")),
    billedAmount: formatMoney(amountValue(claim.amounts, "BILLED")),
    lines: (claim.serviceLines || []).map(normalizeServiceLine),
    raw: claim,
  };
}
