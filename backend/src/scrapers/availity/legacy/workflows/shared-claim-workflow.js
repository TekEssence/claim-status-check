"use strict";

const logger = require("../utils/logger");
const { PROVIDERS, searchMemberWithProvider } = require("../pages/claim-status-member.page");
const { searchHipaaWithProvider } = require("../pages/claim-status-hipaa.page");
const { getResultRows, normalizeMoney, normalizeDateText, waitForSearchResultsToSettle } = require("../pages/results.page");
const {
  extractDenied,
  extractHipaaDenied,
  extractHipaaInProcess,
  extractHipaaPaid,
  extractInProcess,
  extractPaid,
  returnToResults,
  waitForClaimDetailPage
} = require("../pages/claim-detail.page");
const { renderClaimSummary, renderFailedSummary } = require("../services/summary-renderer");

function buildReturnedRowsSummary(resultRows) {
  if (!resultRows.length) {
    return "No parsed result rows were available.";
  }

  return resultRows.slice(0, 5).map((result, index) => {
    return `returned row ${index + 1}: service_date=${result.serviceDate || "blank"}, billed=${result.billedAmount || "blank"}, finalized_date=${result.finalizedDate || "blank"}, claim=${result.claimNumber || "blank"}, status=${result.status.display || "blank"}`;
  }).join("; ");
}

function selectLatestFinalizedMatchedRow(matchedRows, sourceTab) {
  if (matchedRows.length <= 1) {
    return {
      selectedRow: matchedRows[0] || null,
      notes: ""
    };
  }

  const rowsWithFinalizedDate = matchedRows.filter((matchedRow) => matchedRow.finalizedDateValue);
  if (!rowsWithFinalizedDate.length) {
    const message = `${matchedRows.length} ${sourceTab} rows matched Service Date + Charges, but none had Finalized Date. Claim status was not extracted.`;
    return {
      selectedRow: null,
      notes: message
    };
  }

  rowsWithFinalizedDate.sort((a, b) => b.finalizedDateValue.getTime() - a.finalizedDateValue.getTime());
  const selectedRow = rowsWithFinalizedDate[0];
  return {
    selectedRow,
    notes: `${matchedRows.length} ${sourceTab} rows matched Service Date + Charges. Selected latest finalized date ${selectedRow.finalizedDate} for claim ${selectedRow.claimNumber || "blank"}.`
  };
}

function collectMissingExtractionFields(extracted, sourceTab = "") {
  const missing = [];
  const lines = extracted.lines || [];

  if (!extracted.claimNumber) {
    missing.push("claimNumber");
  }
  if (!extracted.claimStatus) {
    missing.push("claimStatus");
  }

  if (extracted.type === "paid") {
    if (lines.length === 0) {
      missing.push("cptLines");
    }
    lines.forEach((line, index) => {
      if (!line.procedureCode) {
        missing.push(`line${index + 1}.procedureCode`);
      }
    });
  }

  if (extracted.type === "denied") {
    if (lines.length === 0) {
      missing.push("cptLines");
    }
    lines.forEach((line, index) => {
      if (!line.procedureCode) {
        missing.push(`line${index + 1}.procedureCode`);
      }

      const isHipaaBlankRemarkAllowed = sourceTab === "HIPAA Standard" && !line.remarkCode;
      if (!isHipaaBlankRemarkAllowed && !line.remarkCode) {
        missing.push(`line${index + 1}.remarkCode`);
      }
      if (!isHipaaBlankRemarkAllowed && line.remarkCode && !line.description) {
        missing.push(`line${index + 1}.description`);
      }
    });
  }

  if (extracted.type === "in_process" && !extracted.receivedDate) {
    missing.push("receivedDate");
  }

  return missing;
}

async function extractMatchedRow(page, matchedRow, sourceTab = "Member") {
  logger.info(
    `Preparing to extract matched row: claim="${matchedRow.claimNumber}", status="${matchedRow.status.display}", service_date="${matchedRow.serviceDate}", billed="${matchedRow.billedAmount}"`
  );

  if (matchedRow.status.type === "unsupported") {
    logger.info(`Unsupported status detected on results page. Skipping detail click for claim ${matchedRow.claimNumber}`);
    return {
      type: "unsupported",
      claimNumber: matchedRow.claimNumber,
      claimStatus: matchedRow.status.display
    };
  }

  await matchedRow.row.click();
  logger.info(`Clicked matched result row for claim ${matchedRow.claimNumber}. Waiting for detail page.`);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await waitForClaimDetailPage(page);
  logger.success(`Detail page loaded for claim ${matchedRow.claimNumber}`);

  if (matchedRow.status.type === "in_process") {
    logger.info(`Extracting IN PROCESS/PENDING detail for claim ${matchedRow.claimNumber}`);
    const extracted = sourceTab === "HIPAA Standard"
      ? await extractHipaaInProcess(page, matchedRow.status.display)
      : await extractInProcess(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }
  if (matchedRow.status.type === "paid" || matchedRow.status.type === "denied") {
    logger.info(`Extracting finalized CPT-level detail for claim ${matchedRow.claimNumber}. Claim-level status="${matchedRow.status.display}"`);
    const extracted = sourceTab === "HIPAA Standard"
      ? await extractHipaaPaid(page, matchedRow.status.display)
      : await extractPaid(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  return {
    type: "unsupported",
    claimNumber: matchedRow.claimNumber,
    claimStatus: matchedRow.status.display
  };
}

function attachSummaryContext(extracted, matchedRow, payerName) {
  return {
    ...extracted,
    payerName,
    serviceDate: matchedRow.serviceDate || "",
    finalizedDate: matchedRow.finalizedDate || "",
    claimNumber: extracted.claimNumber || matchedRow.claimNumber || "",
    claimStatus: extracted.claimStatus || matchedRow.status.display || ""
  };
}

async function processParsedSearchResults(page, row, provider, resultSummary, sourceTab, resultRows, noMatchStatus = "failed") {
  logger.info(
    `Matching ${sourceTab} returned rows against input: service_date="${row.data["Service Date"]}", charges="${row.data.Charges}"`
  );
  const inputDate = normalizeDateText(row.data["Service Date"]);
  const inputCharge = normalizeMoney(row.data.Charges);

  resultRows.forEach((result) => {
    logger.info(
      `Parsed result row ${result.index + 1}: service_date="${result.serviceDate}", billed="${result.billedAmount}", normalized_billed="${normalizeMoney(result.billedAmount)}", finalized_date="${result.finalizedDate}", claim="${result.claimNumber}", status="${result.status.display}"`
    );
  });

  const matchedRows = resultRows.filter((result) => {
    return result.serviceDate === inputDate && normalizeMoney(result.billedAmount) === inputCharge;
  });
  logger.info(`Matched ${matchedRows.length} ${sourceTab} result row(s) by Service Date + Charges`);
  if (matchedRows.length === 0) {
    logger.warn(`No ${sourceTab} rows matched input after parsing. Check result-row parse logs above if values look different in portal.`);
  }
  matchedRows.slice(0, 5).forEach((matchedRow, index) => {
    logger.info(
      `Matched ${sourceTab} row ${index + 1}: claim="${matchedRow.claimNumber}", status="${matchedRow.status.display}", service_date="${matchedRow.serviceDate}", billed="${matchedRow.billedAmount}", finalized_date="${matchedRow.finalizedDate}"`
    );
  });

  if (matchedRows.length === 0) {
    const returnedRowsSummary = buildReturnedRowsSummary(resultRows);
    const returnedCount = resultSummary.total ?? (resultRows.length || "unknown");
    const mismatchReason = `Portal returned ${returnedCount} rows in ${sourceTab} for provider ${provider}, but none matched input Service Date ${row.data["Service Date"]} and Charges ${row.data.Charges}. ${returnedRowsSummary}`;
    return {
      status: noMatchStatus,
      summaries: [renderFailedSummary(mismatchReason)],
      matchCount: 0,
      provider,
      sourceTab,
      notes: mismatchReason
    };
  }

  const summaries = [];
  const notes = [];
  const latestSelection = selectLatestFinalizedMatchedRow(matchedRows, sourceTab);
  if (latestSelection.notes) {
    logger.info(latestSelection.notes);
    notes.push(latestSelection.notes);
  }

  if (!latestSelection.selectedRow) {
    return {
      status: "failed",
      summaries: [renderFailedSummary(latestSelection.notes)],
      matchCount: matchedRows.length,
      provider,
      sourceTab,
      notes: latestSelection.notes
    };
  }

  for (const matchedRow of [latestSelection.selectedRow]) {
    const extracted = attachSummaryContext(await extractMatchedRow(page, matchedRow, sourceTab), matchedRow, row.data["Payer Name"] || "");
    summaries.push(renderClaimSummary(extracted));
    const missingFields = collectMissingExtractionFields(extracted, sourceTab);
    if (missingFields.length > 0) {
      logger.warn(
        `Missing expected ${sourceTab} ${extracted.type} extraction fields for claim "${extracted.claimNumber || matchedRow.claimNumber}": ${missingFields.join(", ")}`
      );
    }
    logger.success(
      `Extracted ${sourceTab} claim detail: claim="${extracted.claimNumber || matchedRow.claimNumber}", type="${extracted.type}", status="${extracted.claimStatus || matchedRow.status.display}"`
    );

    if (extracted.type === "unsupported") {
      notes.push(`Unsupported status for claim ${extracted.claimNumber}: ${extracted.claimStatus}`);
    } else {
      await returnToResults(page);
    }
  }

  return {
    status: "success",
    summaries,
    matchCount: matchedRows.length,
    provider,
    sourceTab,
    notes: notes.join("; ")
  };
}

async function processSearchResults(page, row, provider, resultSummary, sourceTab, noMatchStatus = "failed") {
  const resultRows = await getResultRows(page);
  return processParsedSearchResults(page, row, provider, resultSummary, sourceTab, resultRows, noMatchStatus);
}

async function runMemberProviderSearch(page, row, providerOrder = PROVIDERS, searchFunction = searchMemberWithProvider) {
  let lastProviderFailure = "";

  for (const provider of providerOrder) {
    await searchFunction(page, provider, row.data);

    logger.info(`Waiting up to 5 seconds for ${provider} search results to settle`);
    const resultSummary = await waitForSearchResultsToSettle(page, 5000);
    logger.info(
      `Provider ${provider} search result summary: heading="${resultSummary.headingText || "not found"}", total=${resultSummary.total ?? "unknown"}, rows=${resultSummary.resultRowCount ?? "unknown"}, no_results_message=${resultSummary.noResultsMessageVisible}, alert="${resultSummary.portalAlertMessage || ""}"`
    );

    const resultRows = await getResultRows(page);

    if (resultSummary.hasPortalAlert && resultRows.length === 0) {
      logger.warn(`Provider ${provider} returned portal alert without claim rows: ${resultSummary.portalAlertMessage}`);
      lastProviderFailure = `Provider ${provider}: ${resultSummary.portalAlertMessage}`;
      continue;
    }

    if (resultSummary.hasPortalAlert) {
      logger.info(`Provider ${provider} returned an informational alert with result rows. Continuing to parse rows. Alert="${resultSummary.portalAlertMessage}"`);
    }

    if (resultRows.length === 0) {
      logger.warn(`Provider ${provider} returned no claim rows. Trying next provider if available.`);
      lastProviderFailure = `Provider ${provider}: no claim rows returned.`;
      continue;
    }

    return processParsedSearchResults(page, row, provider, resultSummary, "Member", resultRows, "not_found");
  }

  return {
    status: "not_found",
    summaries: [renderFailedSummary(lastProviderFailure || "Claim not found in Member tab for matching Service Date and Charges.")],
    matchCount: 0,
    provider: providerOrder.join(", "),
    sourceTab: "Member",
    notes: lastProviderFailure
      ? `Searched Member providers: ${providerOrder.join(", ")}. Last provider failure: ${lastProviderFailure}`
      : `Searched Member providers: ${providerOrder.join(", ")}. No matching Service Date + Charges found.`
  };
}

async function runHipaaProviderSearch(page, row, providerOrder = PROVIDERS) {
  let lastProviderFailure = "";

  for (const provider of providerOrder) {
    await searchHipaaWithProvider(page, provider, row.data);

    logger.info(`Waiting up to 5 seconds for ${provider} HIPAA results to settle`);
    const resultSummary = await waitForSearchResultsToSettle(page, 5000);
    logger.info(
      `HIPAA provider ${provider} search result summary: heading="${resultSummary.headingText || "not found"}", total=${resultSummary.total ?? "unknown"}, rows=${resultSummary.resultRowCount ?? "unknown"}, no_results_message=${resultSummary.noResultsMessageVisible}, alert="${resultSummary.portalAlertMessage || ""}"`
    );

    const resultRows = await getResultRows(page);

    if (resultSummary.hasPortalAlert && resultRows.length === 0) {
      logger.warn(`HIPAA provider ${provider} returned portal alert without claim rows: ${resultSummary.portalAlertMessage}`);
      lastProviderFailure = `Provider ${provider}: ${resultSummary.portalAlertMessage}`;
      continue;
    }

    if (resultSummary.hasPortalAlert) {
      logger.info(`HIPAA provider ${provider} returned an informational alert with result rows. Continuing to parse rows. Alert="${resultSummary.portalAlertMessage}"`);
    }

    if (resultRows.length === 0) {
      logger.warn(`HIPAA provider ${provider} returned no claim rows. Trying next provider if available.`);
      lastProviderFailure = `Provider ${provider}: no claim rows returned.`;
      continue;
    }

    return processParsedSearchResults(page, row, provider, resultSummary, "HIPAA Standard", resultRows);
  }

  return {
    status: "failed",
    summaries: [renderFailedSummary(lastProviderFailure || "Claim not found in HIPAA Standard tab for matching Service Date and Charges.")],
    matchCount: 0,
    provider: providerOrder.join(", "),
    sourceTab: "HIPAA Standard",
    notes: lastProviderFailure
      ? `Searched HIPAA providers: ${providerOrder.join(", ")}. Last provider failure: ${lastProviderFailure}`
      : `Searched HIPAA providers: ${providerOrder.join(", ")}. No matching Service Date + Charges found.`
  };
}

module.exports = {
  processParsedSearchResults,
  processSearchResults,
  runHipaaProviderSearch,
  runMemberProviderSearch
};
