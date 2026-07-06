"use strict";

function valueOrBlank(value) {
  const cleaned = value === undefined || value === null ? "" : String(value).trim();
  return cleaned || "NA";
}

function cleanOutputText(value) {
  return String(value || "")
    .replace(/\[[^\]]+\]\s*Show\s+(more|less)\.*\s*/gi, "")
    .replace(/\bShow\s+(more|less)\.*\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function moneyOrBlank(value) {
  return valueOrBlank(value);
}

function hasValue(value) {
  const cleaned = value === undefined || value === null ? "" : String(value).trim();
  return Boolean(cleaned) && cleaned !== "NA";
}

function moneyToNumber(value) {
  const numeric = Number(String(value || "").replace(/[$,\s]/g, "").trim());
  return Number.isFinite(numeric) ? numeric : 0;
}

function isProcessedLine(item) {
  return moneyToNumber(item.paid) > 0 || moneyToNumber(item.deductible) > 0;
}

function firstServiceDate(claim) {
  if (claim.serviceDate) {
    return claim.serviceDate;
  }

  const firstLineServiceDates = valueOrBlank((claim.lines || [])[0]?.serviceDates);
  const match = firstLineServiceDates.match(/\d{2}\/\d{2}\/\d{4}/);
  return match ? match[0] : firstLineServiceDates;
}

function renderProcessedHeader(claim) {
  return `DOS ${valueOrBlank(firstServiceDate(claim))} Claim processed by ${valueOrBlank(claim.payerName)} on ${valueOrBlank(claim.finalizedDate)} under Claim # ${valueOrBlank(claim.claimNumber)}.`;
}

function renderPaymentLine(claim) {
  return `Payment issued via Check/EFT # ${valueOrBlank(claim.checkNumber)} dated ${valueOrBlank(claim.checkDate)}.`;
}

function renderPaidSummary(claim) {
  const header = [
    renderProcessedHeader(claim),
    renderPaymentLine(claim)
  ];

  if (claim.lineSummaryMode === "status_details") {
    const statusDetailLines = (claim.lines || []).map((item) => {
      const fields = [];
      if (hasValue(item.status)) {
        fields.push(`Status ${valueOrBlank(item.status)}`);
      }
      if (hasValue(item.billed)) {
        fields.push(`Billed ${moneyOrBlank(item.billed)}`);
      }
      if (hasValue(item.paid)) {
        fields.push(`Paid ${moneyOrBlank(item.paid)}`);
      }
      if (hasValue(item.modifier)) {
        fields.push(`Modifier ${valueOrBlank(item.modifier)}`);
      }
      if (hasValue(item.quantity)) {
        fields.push(`Quantity ${valueOrBlank(item.quantity)}`);
      }
      if (hasValue(item.description)) {
        fields.push(`Status Details: ${valueOrBlank(cleanOutputText(item.description))}`);
      }

      return `CPT ${valueOrBlank(item.procedureCode)}: ${fields.join(", ")}.`;
    });

    return [...header, ...statusDetailLines].join("\n");
  }

  const cptLines = (claim.lines || []).map((item) => {
    if (isProcessedLine(item)) {
      return `CPT ${valueOrBlank(item.procedureCode)}: Allowed Amount ${moneyOrBlank(item.allowed)}, Paid Amount ${moneyOrBlank(item.paid)}, Deductible ${moneyOrBlank(item.deductible)}, Copay ${moneyOrBlank(item.copay)}, Coinsurance ${moneyOrBlank(item.coinsurance)}.`;
    }

    const remarkCode = valueOrBlank(item.remarkCode || item.reasonRemarkCode);
    const description = valueOrBlank(cleanOutputText(item.description));
    const denialReason = [remarkCode, description].filter((value) => value !== "NA").join(" - ") || "NA";
    return `CPT ${valueOrBlank(item.procedureCode)} denied for ${denialReason}.`;
  });

  return [...header, ...cptLines].join("\n");
}

function renderDeniedSummary(claim) {
  const header = renderProcessedHeader(claim);
  const cptLines = (claim.lines || []).map((item) => {
    const remarkCode = valueOrBlank(item.remarkCode);
    const description = valueOrBlank(cleanOutputText(item.description));
    const denialReason = [remarkCode, description].filter(Boolean).join(" - ");
    return `CPT ${valueOrBlank(item.procedureCode)} denied for ${denialReason}.`;
  });

  return [header, ...cptLines].join("\n");
}

function renderInProcessSummary(claim) {
  return `DOS ${valueOrBlank(firstServiceDate(claim))} Claim processed by ${valueOrBlank(claim.payerName)} on ${valueOrBlank(claim.finalizedDate)} under Claim # ${valueOrBlank(claim.claimNumber)} claim in process please allow some time to follow up the claim.`;
}

function renderUnsupportedSummary(claim) {
  return `DOS ${valueOrBlank(firstServiceDate(claim))} Claim processed by ${valueOrBlank(claim.payerName)} on ${valueOrBlank(claim.finalizedDate)} under Claim # ${valueOrBlank(claim.claimNumber)} Current status ${valueOrBlank(claim.claimStatus)}.`;
}

function renderClaimSummary(claim) {
  if (claim.type === "paid") {
    return renderPaidSummary(claim);
  }
  if (claim.type === "denied") {
    return renderDeniedSummary(claim);
  }
  if (claim.type === "in_process") {
    return renderInProcessSummary(claim);
  }
  return renderUnsupportedSummary(claim);
}

function renderFailedSummary(message) {
  return `FAILED - ${message}`;
}

module.exports = {
  renderClaimSummary,
  renderFailedSummary
};
