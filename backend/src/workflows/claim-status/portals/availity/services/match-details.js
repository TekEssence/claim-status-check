"use strict";

function asText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeDate(value) {
  const raw = asText(value);
  const match = raw.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!match) return raw;
  return `${match[1].padStart(2, "0")}/${match[2].padStart(2, "0")}/${match[3]}`;
}

function normalizeMoney(value) {
  const numeric = Number(asText(value).replace(/[,$\s]/g, ""));
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
}

function normalizeIdentifier(value) {
  return asText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function normalizePatientName(value) {
  return asText(value).replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function countMatches(resultRows, predicate) {
  return resultRows.filter(predicate).length;
}

function statusLine(label, compared, matched, inputValue) {
  if (!compared) return `${label}: not compared`;
  return `${label}: ${matched > 0 ? "matched" : "not matched"} (${matched}/${compared}; input=${asText(inputValue) || "blank"})`;
}

function buildReturnedRowsSummary(resultRows) {
  if (!resultRows.length) return "Returned rows: none parsed.";
  return `Returned rows sample: ${resultRows.slice(0, 5).map((result, index) => {
    const status = result.status?.display || result.status || "";
    return `row ${index + 1} service_date=${result.serviceDate || "blank"}, billed=${result.billedAmount || "blank"}, member_id=${result.memberId || "blank"}, patient_id=${result.patientId || "blank"}, patient_name=${result.patientName || "blank"}, finalized_date=${result.finalizedDate || "blank"}, claim=${result.claimNumber || "blank"}, status=${status || "blank"}`;
  }).join("; ")}`;
}

function buildMatchDetails(options) {
  const rowData = options.rowData || {};
  const resultRows = Array.isArray(options.resultRows) ? options.resultRows : [];
  const matchedRows = Array.isArray(options.matchedRows) ? options.matchedRows : [];
  const inputDate = normalizeDate(rowData["Service Date"]);
  const inputCharge = normalizeMoney(rowData.Charges);
  const inputMemberId = normalizeIdentifier(rowData["Subscriber No"]);
  const inputPatientId = normalizeIdentifier(rowData["Patient ID"]);
  const inputPatientName = normalizePatientName(rowData["Patient Name"]);
  const compared = resultRows.length;

  const dateMatches = inputDate ? countMatches(resultRows, (result) => normalizeDate(result.serviceDate) === inputDate) : 0;
  const chargeMatches = inputCharge ? countMatches(resultRows, (result) => normalizeMoney(result.billedAmount) === inputCharge) : 0;
  const memberMatches = inputMemberId ? countMatches(resultRows, (result) => normalizeIdentifier(result.memberId) === inputMemberId) : 0;
  const patientIdMatches = inputPatientId ? countMatches(resultRows, (result) => normalizeIdentifier(result.patientId) === inputPatientId) : 0;
  const patientNameMatches = inputPatientName ? countMatches(resultRows, (result) => normalizePatientName(result.patientName) === inputPatientName) : 0;

  return [
    `Source Tab: ${options.sourceTab || "blank"}`,
    `Provider: ${options.provider || "blank"}`,
    `Match Rule: ${options.matchLabel || "blank"}`,
    `Final matched rows: ${matchedRows.length}/${compared}`,
    statusLine("Service Date", Boolean(inputDate), dateMatches, rowData["Service Date"]),
    statusLine("Charges/Billed Amount", Boolean(inputCharge), chargeMatches, rowData.Charges),
    statusLine("Member ID", Boolean(inputMemberId), memberMatches, rowData["Subscriber No"]),
    statusLine("Patient ID", Boolean(inputPatientId), patientIdMatches, rowData["Patient ID"]),
    statusLine("Patient Name", Boolean(inputPatientName), patientNameMatches, rowData["Patient Name"]),
    buildReturnedRowsSummary(resultRows),
  ].join("\n");
}

module.exports = {
  buildMatchDetails,
  buildReturnedRowsSummary,
};
