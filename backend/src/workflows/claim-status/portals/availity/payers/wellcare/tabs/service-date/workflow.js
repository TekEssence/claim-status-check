"use strict";

const logger = require("../../../../utils/logger");
const {
  hasUsableValue,
  normalizeMemberId,
  normalizePatientName,
  normalizePatientNameWithoutInitial,
  processServiceDateProviderLoop
} = require("../../../../pages/service-dates.page");
const { normalizeMoney, normalizeDateText } = require("../../../../pages/results.page");
const { renderClaimSummary, renderFailedSummary } = require("../../../../services/summary-renderer");
const { normalizeStatus } = require("../../../../services/status-normalizer");
const { extractBracketedPatientId } = require("../../../../services/patient-identity");
const {
  extractInProcess,
  extractWellcareDenied,
  extractWellcarePaid,
  returnToResults,
  waitForClaimDetailPage
} = require("../../../../pages/claim-detail.page");


function selectWellcareMatchedRows(matchedRows, sourceTab) {
  if (matchedRows.length <= 1) {
    return {
      selectedRows: matchedRows[0] ? [matchedRows[0]] : [],
      notes: ""
    };
  }

  const rowsWithFinalizedDate = matchedRows.filter((matchedRow) => matchedRow.finalizedDateValue);
  if (!rowsWithFinalizedDate.length) {
    const message = `${matchedRows.length} ${sourceTab} rows matched Service Date + Billed Amount + Member ID and all had blank Finalized Date. Extracting all matching rows.`;
    return {
      selectedRows: matchedRows,
      notes: message
    };
  }

  rowsWithFinalizedDate.sort((a, b) => b.finalizedDateValue.getTime() - a.finalizedDateValue.getTime());
  const selectedRow = rowsWithFinalizedDate[0];
  return {
    selectedRows: [selectedRow],
    notes: `${matchedRows.length} ${sourceTab} rows matched Service Date + Billed Amount + Member ID. Selected latest finalized date ${selectedRow.finalizedDate} for claim ${selectedRow.claimNumber || "blank"}.`
  };
}

async function extractWellcareMatchedRow(page, matchedRow, sourceTab) {
  logger.info(
    `Preparing to extract Wellcare matched row: claim="${matchedRow.claimNumber}", status="${matchedRow.status.display}", service_date="${matchedRow.serviceDate}", billed="${matchedRow.billedAmount}", member_id="${matchedRow.memberId}"`
  );

  if (matchedRow.status.type === "unsupported") {
    return {
      type: "unsupported",
      claimNumber: matchedRow.claimNumber,
      claimStatus: matchedRow.status.display
    };
  }

  await matchedRow.row.click();
  logger.info(`Clicked Wellcare matched result row for claim ${matchedRow.claimNumber}. Waiting for detail page.`);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await waitForClaimDetailPage(page);
  logger.success(`Wellcare detail page loaded for claim ${matchedRow.claimNumber}`);

  if (matchedRow.status.type === "in_process") {
    const extracted = await extractInProcess(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  if (matchedRow.status.type === "paid") {
    const extracted = await extractWellcarePaid(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  if (matchedRow.status.type === "denied") {
    const extracted = await extractWellcareDenied(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  return {
    type: "unsupported",
    claimNumber: matchedRow.claimNumber,
    claimStatus: matchedRow.status.display
  };
}

async function processWellcareServiceDateResults(page, row, provider, resultSummary, options = {}) {
  const sourceTab = "Service Dates";
  const resultRows = options.resultRows || [];
  const inputDate = normalizeDateText(row.data["Service Date"]);
  const inputCharge = normalizeMoney(row.data.Charges);
  const matchingPolicy = options.matchingPolicy || {};
  const shouldMatchBilledAmount = matchingPolicy.matchBilledAmount !== false;
  const inputMemberId = hasUsableValue(row.data["Subscriber No"]) ? normalizeMemberId(row.data["Subscriber No"]) : "";
  const inputPatientName = hasUsableValue(row.data["Patient Name"]) ? normalizePatientName(row.data["Patient Name"]) : "";
  const inputPatientId = normalizeMemberId(row.data["Patient ID"]) || extractBracketedPatientId(row.data["Patient Name"]);
  const inputPatientNameWithoutInitial = hasUsableValue(row.data["Patient Name"]) ? normalizePatientNameWithoutInitial(row.data["Patient Name"]) : "";
  const shouldMatchMemberId = matchingPolicy.memberIdMode !== "disabled"
    && (matchingPolicy.memberIdMode !== "whenPresent" || Boolean(inputMemberId));
  const shouldMatchPatientId = Boolean(matchingPolicy.patientIdFallback && inputPatientId);
  const shouldMatchPatientName = Boolean(matchingPolicy.patientNameFallback && !inputMemberId && inputPatientName);
  let matchLabel = shouldMatchMemberId
    ? `${shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Member ID`
    : shouldMatchPatientId
      ? `${shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Patient ID`
    : shouldMatchPatientName
      ? `${shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Patient Name`
      : shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date";

  resultRows.forEach((result) => {
    logger.info(
      `Parsed Wellcare Service Dates row ${result.index + 1}: service_date="${result.serviceDate}", billed="${result.billedAmount}", normalized_billed="${normalizeMoney(result.billedAmount)}", member_id="${result.memberId}", patient_name="${result.patientName}", finalized_date="${result.finalizedDate}", claim="${result.claimNumber}", status="${result.status.display}"`
    );
  });

  let matchedRows = resultRows.filter((result) => {
    return result.serviceDate === inputDate
      && (!shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputCharge)
      && (!shouldMatchMemberId || normalizeMemberId(result.memberId) === inputMemberId)
      && (!shouldMatchPatientId || (normalizeMemberId(result.patientId) || extractBracketedPatientId(result.patientName)) === inputPatientId)
      && (!shouldMatchPatientName || normalizePatientName(result.patientName) === inputPatientName);
  });

  if (matchedRows.length === 0 && matchingPolicy.patientIdFallback && inputPatientId) {
    logger.info("No Service Dates rows matched Member ID. Applying configured bracketed Patient ID fallback.");
    matchedRows = resultRows.filter((result) => {
      return result.serviceDate === inputDate
        && (!shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputCharge)
        && (normalizeMemberId(result.patientId) || extractBracketedPatientId(result.patientName)) === inputPatientId;
    });
    matchLabel = `${shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Patient ID`;
  }

  if (matchedRows.length === 0 && matchingPolicy.patientNameFallback && inputMemberId && inputPatientName) {
    logger.info("No Wellcare Service Dates rows matched Member ID. Applying configured Patient Name fallback.");
    matchedRows = resultRows.filter((result) => {
      return result.serviceDate === inputDate
        && (!shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputCharge)
        && normalizePatientName(result.patientName) === inputPatientName;
    });
    matchLabel = `${shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Patient Name`;
  }

  if (matchedRows.length === 0 && matchingPolicy.patientNameWithoutInitialFallback && inputPatientNameWithoutInitial) {
    logger.info("No Wellcare Service Dates rows matched exact Patient Name. Applying configured trailing-initial fallback.");
    matchedRows = resultRows.filter((result) => {
      return result.serviceDate === inputDate
        && (!shouldMatchBilledAmount || normalizeMoney(result.billedAmount) === inputCharge)
        && normalizePatientNameWithoutInitial(result.patientName) === inputPatientNameWithoutInitial;
    });
    matchLabel = `${shouldMatchBilledAmount ? "Service Date + Billed Amount" : "Service Date"} + Patient Name without initial`;
  }

  logger.info(`Matched ${matchedRows.length} Wellcare Service Dates result row(s) by ${matchLabel}`);

  if (matchedRows.length === 0) {
    const returnedCount = resultSummary.total ?? (resultRows.length || "unknown");
    const dateMatchedRows = resultRows.filter((result) => result.serviceDate === inputDate);
    const billedMatchedRows = shouldMatchBilledAmount
      ? dateMatchedRows.filter((result) => normalizeMoney(result.billedAmount) === inputCharge)
      : dateMatchedRows;
    const mismatchDetail = !dateMatchedRows.length
      ? `Service Date mismatch for input ${row.data["Service Date"] || "blank"}.`
      : shouldMatchBilledAmount && !billedMatchedRows.length
        ? `Billed Amount mismatch for input Charges ${row.data.Charges || "blank"}.`
        : matchingPolicy.reportCombinedMemberPatientMismatch && inputMemberId && inputPatientName
          ? `Member ID and Patient Name mismatch for input Member ID ${row.data["Subscriber No"] || "blank"} and Patient Name ${row.data["Patient Name"] || "blank"}.`
          : matchLabel.includes("Member ID")
            ? `Member ID mismatch for input ${row.data["Subscriber No"] || "blank"}.`
            : matchLabel.includes("Patient Name")
              ? `Patient Name mismatch for input ${row.data["Patient Name"] || "blank"}.`
              : `No matching ${sourceTab} row found.`;
    const mismatchReason = [
      `Portal returned ${returnedCount} rows in ${sourceTab} for provider ${provider}. ${mismatchDetail}`,
      resultSummary.portalAlertMessage
    ].filter(Boolean).join("\n");
    return {
      status: "failed",
      summaries: [renderFailedSummary(mismatchReason)],
      matchCount: 0,
      provider,
      sourceTab,
      notes: mismatchReason
    };
  }

  const selection = selectWellcareMatchedRows(matchedRows, sourceTab);
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
      notes: selection.notes
    };
  }

  const summaries = [];
  const details = [];
  for (let index = 0; index < selection.selectedRows.length; index += 1) {
    const matchedRow = selection.selectedRows[index];
    const extracted = await extractWellcareMatchedRow(page, matchedRow, sourceTab);
    const summaryContext = {
      ...extracted,
      payerName: row.data["Payer Name"] || "",
      patientName: matchedRow.patientName || "",
      matchMethod: matchLabel,
      serviceDate: matchedRow.serviceDate || "",
      finalizedDate: matchedRow.finalizedDate || "",
      claimNumber: extracted.claimNumber || matchedRow.claimNumber || "",
      claimStatus: extracted.claimStatus || matchedRow.status.display || ""
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
    notes: [resultSummary.portalAlertMessage, selection.notes].filter(Boolean).join("\n")
  };
}

async function processClaim(page, row, options = {}) {
  logger.info("Using Wellcare workflow: Service Dates tab only.");
  return processServiceDateProviderLoop(page, row, {
    ...options,
    payerLabel: "Wellcare",
    processResults: processWellcareServiceDateResults
  });
}

module.exports = {
  name: "wellcare",
  processClaim
};
