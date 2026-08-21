"use strict";

const { getClaimStatusFrame } = require("./navigation.page");
const { humanDelay } = require("../utils/browser");
const logger = require("../utils/logger");
const { normalizeStatus } = require("../services/status-normalizer");

const SELECTORS = {
  searchResultsHeading: "h5:has-text('Search Results')",
  hipaaResultsHeading: "span:has-text('Results (Displaying')",
  tableRows: "tbody tr",
  noResultsMessage: "li:has-text('The payer could not find any results based on your search')",
  portalAlert: "[role='alert'], .MuiAlert-root"
};

function normalizeMoney(value) {
  const numeric = Number(String(value || "").replace(/[$,\s]/g, "").trim());
  return Number.isFinite(numeric) ? numeric.toFixed(2) : "";
}

function normalizeDateText(value) {
  const match = String(value || "").match(/\d{2}\/\d{2}\/\d{4}/);
  return match ? match[0] : "";
}

function parseDateValue(value) {
  const normalized = normalizeDateText(value);
  const [month, day, year] = normalized.split("/").map((part) => Number(part));
  if (!month || !day || !year) {
    return null;
  }

  const date = new Date(year, month - 1, day);
  return Number.isNaN(date.getTime()) ? null : date;
}

async function readRowCells(rowLocator) {
  const cells = await rowLocator.locator("td").evaluateAll((nodes) => nodes.map((node) => node.textContent || ""));
  return cells.map((cell) => cell.replace(/\s+/g, " ").trim());
}

async function readColumnHeaders(frame) {
  const headers = await frame.locator("thead th").evaluateAll((nodes) => nodes.map((node) => node.textContent || "")).catch(() => []);
  return headers.map((header) => header.replace(/\s+/g, " ").trim().toLowerCase());
}

function cellByHeader(cells, headers, headerName) {
  const target = String(headerName || "").toLowerCase();
  const index = headers.findIndex((header) => header === target || header.includes(target));
  return index >= 0 ? cells[index] || "" : "";
}

function inferClaimNumber(cells) {
  return cells.find((cell) => /^[A-Za-z0-9-]{8,}$/.test(cell)) || "";
}

function inferBilledAmount(cells) {
  const moneyCells = cells.filter((cell) => /\$[\d,]+\.\d{2}/.test(cell));
  return moneyCells.length ? moneyCells[moneyCells.length - 1] : "";
}

function inferServiceDate(cells) {
  for (const cell of cells) {
    const date = normalizeDateText(cell);
    if (date) {
      return date;
    }
  }
  return "";
}

function inferStatus(cells) {
  return cells.find((cell) => /(IN\s*-?\s*PROCESS|PENDING|PAID|DENIED)/i.test(cell)) || "";
}

async function getResultRows(page) {
  const frame = await getClaimStatusFrame(page);
  const headers = await readColumnHeaders(frame);
  const rows = frame.locator(SELECTORS.tableRows);
  const count = await rows.count();
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = await readRowCells(row);
    if (cells.length < 2) {
      continue;
    }

    const statusText = await row.locator(".badge").first().innerText({ timeout: 1000 }).catch(() => inferStatus(cells));
    const headerServiceDate = cellByHeader(cells, headers, "service dates");
    const headerBilledAmount = cellByHeader(cells, headers, "billed amount");
    const headerClaimNumber = cellByHeader(cells, headers, "claim number");
    const headerFinalizedDate = cellByHeader(cells, headers, "finalized date");
    results.push({
      index,
      row,
      cells,
      serviceDate: normalizeDateText(headerServiceDate) || inferServiceDate(cells),
      billedAmount: headerBilledAmount || inferBilledAmount(cells),
      claimNumber: headerClaimNumber || inferClaimNumber(cells),
      finalizedDate: normalizeDateText(headerFinalizedDate),
      finalizedDateValue: parseDateValue(headerFinalizedDate),
      status: normalizeStatus(statusText || inferStatus(cells))
    });
  }

  return results;
}

async function findMatchingRows(page, rowData) {
  const results = await getResultRows(page);
  const inputDate = normalizeDateText(rowData["Service Date"]);
  const inputCharge = normalizeMoney(rowData.Charges);

  results.forEach((result) => {
    logger.info(
      `Parsed result row ${result.index + 1}: service_date="${result.serviceDate}", billed="${result.billedAmount}", normalized_billed="${normalizeMoney(result.billedAmount)}", finalized_date="${result.finalizedDate}", claim="${result.claimNumber}", status="${result.status.display}"`
    );
  });

  return results.filter((result) => {
    return result.serviceDate === inputDate && normalizeMoney(result.billedAmount) === inputCharge;
  });
}

async function getSearchResultSummary(page) {
  const frame = await getClaimStatusFrame(page);
  const noResultsMessageVisible = await frame.locator(SELECTORS.noResultsMessage).isVisible().catch(() => false);
  const resultRowCount = await frame.locator(SELECTORS.tableRows).evaluateAll((rows) => {
    return rows.filter((row) => row.querySelectorAll("td").length >= 2).length;
  }).catch(() => 0);
  const portalAlertMessage = await frame.locator(SELECTORS.portalAlert).first()
    .innerText({ timeout: 1000 })
    .then((text) => text.replace(/\s+/g, " ").trim())
    .catch(() => "");
  let headingText = await frame.locator(SELECTORS.searchResultsHeading).first().innerText().catch(() => "");
  if (!headingText) {
    headingText = await frame.locator(SELECTORS.hipaaResultsHeading).first().innerText().catch(() => "");
  }
  const displayMatch = headingText.match(/Displaying\s+(\d+)\s*-\s*(\d+)\s+of\s+(\d+)/i);
  const total = displayMatch ? Number(displayMatch[3]) : null;

  return {
    headingText,
    total,
    hasResults: Number.isFinite(total) && total > 0,
    hasResultRows: resultRowCount > 0,
    resultRowCount,
    hasZeroResults: noResultsMessageVisible || total === 0,
    noResultsMessageVisible,
    hasPortalAlert: Boolean(portalAlertMessage),
    portalAlertMessage
  };
}

async function waitForSearchResultsToSettle(page, timeoutMs = 5000) {
  let latestSummary = null;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    latestSummary = await getSearchResultSummary(page);

    if (latestSummary.hasResultRows || latestSummary.noResultsMessageVisible) {
      return latestSummary;
    }

    await humanDelay(1000, 1500);
  }

  return latestSummary || getSearchResultSummary(page);
}

async function hasNoResults(page) {
  const frame = await getClaimStatusFrame(page);
  return frame.locator(SELECTORS.noResultsMessage).isVisible().catch(() => false);
}

module.exports = {
  findMatchingRows,
  getSearchResultSummary,
  getResultRows,
  hasNoResults,
  waitForSearchResultsToSettle,
  normalizeMoney,
  normalizeDateText
};
