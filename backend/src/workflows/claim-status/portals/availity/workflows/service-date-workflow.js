"use strict";

const logger = require("../utils/logger");
const { PROVIDERS } = require("../pages/claim-status-member.page");
const {
  hasUsableValue,
  normalizeMemberId,
  normalizePatientName,
  normalizePatientNameWithoutInitial,
  readServiceDateResultRows,
  searchServiceDatesWithProvider,
} = require("../pages/service-dates.page");
const { normalizeMoney, normalizeDateText, waitForSearchResultsToSettle } = require("../pages/results.page");
const { returnToResults } = require("../pages/claim-detail.page");
const { renderClaimSummary, renderFailedSummary } = require("../services/summary-renderer");
const { buildMatchDetails } = require("../services/match-details");
const { extractBracketedPatientId } = require("../services/patient-identity");

function selectLatestFinalizedMatchedRows(matchedRows, sourceTab, matchLabel) {
  if (matchedRows.length <= 1) {
    return {
      selectedRows: matchedRows[0] ? [matchedRows[0]] : [],
      notes: "",
    };
  }

  const rowsWithFinalizedDate = matchedRows.filter((matchedRow) => matchedRow.finalizedDateValue);
  if (!rowsWithFinalizedDate.length) {
    return {
      selectedRows: matchedRows,
      notes: `${matchedRows.length} ${sourceTab} rows matched ${matchLabel} and all had blank Finalized Date. Extracting all matching rows.`,
    };
  }

  rowsWithFinalizedDate.sort((a, b) => b.finalizedDateValue.getTime() - a.finalizedDateValue.getTime());
  const selectedRow = rowsWithFinalizedDate[0];
  return {
    selectedRows: [selectedRow],
    notes: `${matchedRows.length} ${sourceTab} rows matched ${matchLabel}. Selected latest finalized date ${selectedRow.finalizedDate} for claim ${selectedRow.claimNumber || "blank"}.`,
  };
}

function getServiceDateMatchInputs(rowData, matchingPolicy) {
  const inputDate = normalizeDateText(rowData["Service Date"]);
  const inputCharge = normalizeMoney(rowData.Charges);
  const shouldMatchBilledAmount = matchingPolicy.matchBilledAmount !== false;
  const inputMemberId = hasUsableValue(rowData["Subscriber No"]) ? normalizeMemberId(rowData["Subscriber No"]) : "";
  const inputPatientName = hasUsableValue(rowData["Patient Name"]) ? normalizePatientName(rowData["Patient Name"]) : "";
  const inputPatientId = normalizeMemberId(rowData["Patient ID"]) || extractBracketedPatientId(rowData["Patient Name"]);
  const inputPatientNameWithoutInitial = hasUsableValue(rowData["Patient Name"]) ? normalizePatientNameWithoutInitial(rowData["Patient Name"]) : "";
  const shouldMatchMemberId = matchingPolicy.memberIdMode !== "disabled"
    && (matchingPolicy.memberIdMode !== "whenPresent" || Boolean(inputMemberId));
  const shouldMatchPatientId = Boolean(matchingPolicy.patientIdFallback && inputPatientId);
  const shouldMatchPatientName = Boolean(matchingPolicy.patientNameFallback && !inputMemberId && inputPatientName);

  return {
    inputDate,
    inputCharge,
    inputMemberId,
    inputPatientId,
    inputPatientName,
    inputPatientNameWithoutInitial,
    shouldMatchBilledAmount,
    shouldMatchMemberId,
    shouldMatchPatientId,
    shouldMatchPatientName,
  };
}

function buildMatchLabel(inputs) {
  const base = inputs.shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date";
  if (inputs.shouldMatchMemberId) return `${base} + Member ID`;
  if (inputs.shouldMatchPatientId) return `${base} + Patient ID`;
  if (inputs.shouldMatchPatientName) return `${base} + Patient Name`;
  return base;
}

function findServiceDateMatches(resultRows, inputs, matchingPolicy, payerLabel, options = {}) {
  let matchLabel = buildMatchLabel(inputs);
  let matchedRows = resultRows.filter((result) => {
    return result.serviceDate === inputs.inputDate
      && (!inputs.shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputs.inputCharge)
      && (!inputs.shouldMatchMemberId || normalizeMemberId(result.memberId) === inputs.inputMemberId)
      && (!inputs.shouldMatchPatientId || (normalizeMemberId(result.patientId) || extractBracketedPatientId(result.patientName)) === inputs.inputPatientId)
      && (!inputs.shouldMatchPatientName || normalizePatientName(result.patientName) === inputs.inputPatientName);
  });

  if (matchedRows.length === 0 && matchingPolicy.patientIdFallback && inputs.inputPatientId) {
    logger.info(`No ${payerLabel} Service Dates rows matched Member ID. Applying configured bracketed Patient ID fallback.`);
    matchedRows = resultRows.filter((result) => {
      return result.serviceDate === inputs.inputDate
        && (!inputs.shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputs.inputCharge)
        && (normalizeMemberId(result.patientId) || extractBracketedPatientId(result.patientName)) === inputs.inputPatientId;
    });
    matchLabel = `${inputs.shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Patient ID`;
  }

  if (matchedRows.length === 0 && matchingPolicy.patientNameFallback && inputs.inputMemberId && inputs.inputPatientName) {
    logger.info(`No ${payerLabel} Service Dates rows matched Member ID. Applying configured Patient Name fallback.`);
    matchedRows = resultRows.filter((result) => {
      return result.serviceDate === inputs.inputDate
        && (!inputs.shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputs.inputCharge)
        && normalizePatientName(result.patientName) === inputs.inputPatientName;
    });
    matchLabel = `${inputs.shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Patient Name`;
  }

  if (matchedRows.length === 0 && matchingPolicy.patientNameWithoutInitialFallback && inputs.inputPatientNameWithoutInitial) {
    logger.info(`No ${payerLabel} Service Dates rows matched exact Patient Name. Applying configured trailing-initial fallback.`);
    matchedRows = resultRows.filter((result) => {
      return result.serviceDate === inputs.inputDate
        && (!inputs.shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputs.inputCharge)
        && normalizePatientNameWithoutInitial(result.patientName) === inputs.inputPatientNameWithoutInitial;
    });
    matchLabel = `${inputs.shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Patient Name without initial`;
  }

  if (matchedRows.length === 0 && matchingPolicy.fuzzyPatientNameFallback && inputs.inputPatientName && typeof options.fuzzyPatientNameMatches === "function") {
    logger.info(`No ${payerLabel} Service Dates rows matched patient name without trailing initial. Applying configured fuzzy Patient Name fallback.`);
    matchedRows = resultRows.filter((result) => {
      return result.serviceDate === inputs.inputDate
        && (!inputs.shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputs.inputCharge)
        && options.fuzzyPatientNameMatches(options.inputPatientNameRaw || "", result.patientName);
    });
    matchLabel = `${inputs.shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + fuzzy Patient Name words`;
  }

  return { matchedRows, matchLabel };
}

function buildMismatchReason(rowData, resultSummary, resultRows, provider, sourceTab, inputs, matchingPolicy, matchLabel) {
  const returnedCount = resultSummary.total ?? (resultRows.length || "unknown");
  const dateMatchedRows = resultRows.filter((result) => result.serviceDate === inputs.inputDate);
  const billedMatchedRows = inputs.shouldMatchBilledAmount
    ? dateMatchedRows.filter((result) => normalizeMoney(result.billedAmount) === inputs.inputCharge)
    : dateMatchedRows;
  const mismatchDetail = !dateMatchedRows.length
    ? `Service Date mismatch for input ${rowData["Service Date"] || "blank"}.`
    : inputs.shouldMatchBilledAmount && !billedMatchedRows.length
      ? `Billed Amount mismatch for input Charges ${rowData.Charges || "blank"}.`
      : matchingPolicy.reportCombinedMemberPatientMismatch && inputs.inputMemberId && inputs.inputPatientName
        ? `Member ID and Patient Name mismatch for input Member ID ${rowData["Subscriber No"] || "blank"} and Patient Name ${rowData["Patient Name"] || "blank"}.`
        : matchLabel.includes("Member ID")
          ? `Member ID mismatch for input ${rowData["Subscriber No"] || "blank"}.`
          : matchLabel.includes("Patient Name")
            ? `Patient Name mismatch for input ${rowData["Patient Name"] || "blank"}.`
            : `No matching ${sourceTab} row found.`;

  return [
    `Portal returned ${returnedCount} rows in ${sourceTab} for provider ${provider}. ${mismatchDetail}`,
    resultSummary.portalAlertMessage,
  ].filter(Boolean).join("\n");
}

async function processServiceDateResults(page, row, provider, resultSummary, options = {}) {
  const sourceTab = options.sourceTab || "Service Dates";
  const payerLabel = options.payerLabel || "Availity";
  const resultRows = options.resultRows || [];
  const matchingPolicy = options.matchingPolicy || {};
  const inputs = getServiceDateMatchInputs(row.data, matchingPolicy);

  resultRows.forEach((result) => {
    logger.info(
      `Parsed ${payerLabel} Service Dates row ${result.index + 1}: service_date="${result.serviceDate}", billed="${result.billedAmount}", normalized_billed="${normalizeMoney(result.billedAmount)}", member_id="${result.memberId}", patient_name="${result.patientName}", finalized_date="${result.finalizedDate}", claim="${result.claimNumber}", status="${result.status?.display || ""}"`
    );
  });

  const { matchedRows, matchLabel } = findServiceDateMatches(resultRows, inputs, matchingPolicy, payerLabel, {
    fuzzyPatientNameMatches: options.fuzzyPatientNameMatches,
    inputPatientNameRaw: row.data["Patient Name"],
  });
  logger.info(`Matched ${matchedRows.length} ${payerLabel} Service Dates result row(s) by ${matchLabel}`);
  const matchDetails = buildMatchDetails({
    sourceTab,
    provider,
    rowData: row.data,
    resultRows,
    matchedRows,
    matchLabel,
  });

  if (matchedRows.length === 0) {
    const mismatchReason = buildMismatchReason(row.data, resultSummary, resultRows, provider, sourceTab, inputs, matchingPolicy, matchLabel);
    return {
      status: "failed",
      summaries: [renderFailedSummary(mismatchReason)],
      matchCount: 0,
      provider,
      sourceTab,
      matchDetails,
      notes: mismatchReason,
    };
  }

  const selectMatchedRows = options.selectMatchedRows || selectLatestFinalizedMatchedRows;
  const selection = selectMatchedRows(matchedRows, sourceTab, matchLabel);
  if (selection.notes) {
    logger.info(selection.notes);
  }

  if (!selection.selectedRows.length) {
    return {
      status: "failed",
      summaries: [renderFailedSummary(selection.notes)],
      matchCount: matchedRows.length,
      provider,
      sourceTab,
      matchDetails,
      notes: selection.notes,
    };
  }

  const summaries = [];
  const details = [];
  for (const matchedRow of selection.selectedRows) {
    const extracted = await options.extractMatchedRow(page, matchedRow, sourceTab);
    const summaryContext = {
      ...extracted,
      payerName: row.data["Payer Name"] || "",
      patientName: matchedRow.patientName || "",
      matchMethod: matchLabel,
      serviceDate: matchedRow.serviceDate || "",
      finalizedDate: matchedRow.finalizedDate || "",
      claimNumber: extracted.claimNumber || matchedRow.claimNumber || "",
      claimStatus: extracted.claimStatus || matchedRow.status?.display || "",
    };
    details.push(summaryContext);
    summaries.push(renderClaimSummary(summaryContext));

    if (extracted.type !== "unsupported") {
      await returnToResults(page);
    }
  }

  return {
    status: "success",
    summaries: [summaries.join("\n\n")],
    details,
    matchCount: matchedRows.length,
    provider,
    sourceTab,
    matchDetails,
    notes: [resultSummary.portalAlertMessage, selection.notes].filter(Boolean).join("\n"),
  };
}

async function runServiceDateProviderSearch(page, row, options = {}) {
  const payerLabel = options.payerLabel || "Availity";
  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : PROVIDERS;
  const searchWithProvider = options.searchWithProvider || searchServiceDatesWithProvider;
  const readResultRows = options.readResultRows || readServiceDateResultRows;

  let lastProviderFailure = "";
  for (const provider of providerOrder) {
    await searchWithProvider(page, provider, row.data, options);

    logger.info(`Waiting up to 5 seconds for ${provider} ${payerLabel} Service Dates results to settle`);
    const resultSummary = await waitForSearchResultsToSettle(page, 5000);
    logger.info(
      `${payerLabel} Service Dates provider ${provider} result summary: heading="${resultSummary.headingText || "not found"}", total=${resultSummary.total ?? "unknown"}, rows=${resultSummary.resultRowCount ?? "unknown"}, no_results_message=${resultSummary.noResultsMessageVisible}, alert="${resultSummary.portalAlertMessage || ""}"`
    );

    const resultRows = await readResultRows(page);
    if (resultSummary.hasPortalAlert && resultRows.length === 0) {
      logger.warn(`${payerLabel} Service Dates provider ${provider} returned portal alert without claim rows: ${resultSummary.portalAlertMessage}`);
      lastProviderFailure = `Provider ${provider}: ${resultSummary.portalAlertMessage}`;
      continue;
    }

    if (resultRows.length === 0) {
      logger.warn(`${payerLabel} Service Dates provider ${provider} returned no claim rows. Trying next provider if available.`);
      lastProviderFailure = `Provider ${provider}: no claim rows returned.`;
      continue;
    }

    return processServiceDateResults(page, row, provider, resultSummary, {
      ...options,
      resultRows,
    });
  }

  return {
    status: "failed",
    summaries: [renderFailedSummary(lastProviderFailure || `Claim not found in ${payerLabel} Service Dates tab for matching Service Date, Charges, and Member ID.`)],
    matchCount: 0,
    provider: providerOrder.join(", "),
    sourceTab: "Service Dates",
    notes: lastProviderFailure
      ? `Searched ${payerLabel} Service Dates providers: ${providerOrder.join(", ")}. Last provider failure: ${lastProviderFailure}`
      : `Searched ${payerLabel} Service Dates providers: ${providerOrder.join(", ")}. No matching Service Date + Charges + Member ID found.`,
  };
}

function createServiceDateWorkflow(definition) {
  async function processClaim(page, row, options = {}) {
    logger.info(`Using ${definition.payerLabel} workflow: Service Dates tab only.`);
    return runServiceDateProviderSearch(page, row, {
      ...options,
      ...definition,
    });
  }

  return {
    name: definition.name,
    processClaim,
  };
}

module.exports = {
  createServiceDateWorkflow,
  processServiceDateResults,
  runServiceDateProviderSearch,
  selectLatestFinalizedMatchedRows,
};
