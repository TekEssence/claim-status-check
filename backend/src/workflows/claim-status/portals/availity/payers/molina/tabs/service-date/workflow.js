"use strict";

const logger = require("../../../../utils/logger");
const { createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const { humanDelay, withRetry } = require("../../../../utils/browser");
const { getClaimStatusFrame } = require("../../../../pages/navigation.page");
const { submitCharmSearchAfterProviderDropdown, trySubmitCharmSearchWithoutProviderDropdown } = require("../../../../pages/charm-provider-search.page");
const {
  clearProviderStateForTaxIdFallback,
  verifyProviderNpiMatches
} = require("../../../../pages/provider-identifiers.page");
const { PROVIDERS } = require("../../../../pages/claim-status-member.page");
const { waitForSearchResultsToSettle, normalizeMoney, normalizeDateText, throwIfVisibleFieldValidation } = require("../../../../pages/results.page");
const { renderClaimSummary, renderFailedSummary } = require("../../../../services/summary-renderer");
const { buildMatchDetails } = require("../../../../services/match-details");
const { normalizeStatus } = require("../../../../services/status-normalizer");
const { extractBracketedPatientId } = require("../../../../services/patient-identity");
const {
  extractInProcess,
  extractWellcareDenied: extractMolinaDenied,
  extractWellcarePaid: extractMolinaPaid,
  returnToResults,
  waitForClaimDetailPage
} = require("../../../../pages/claim-detail.page");

const SELECTORS = {
  serviceDateTab: "button[role='tab']:has-text('Service Dates'), a[role='button']:has-text('Service Dates')",
  providerTaxId: "input#providerTaxId",
  requestedStatus: "input#requestedStatus",
  searchButton: "button#submit-byServiceDates[type='submit']",
  searchResultsHeading: "h5:has-text('Search Results')",
  tableRows: "tbody tr",
  noResultsMessage: "li:has-text('The payer could not find any results based on your search')"
};

function normalizeMemberId(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function hasUsableValue(value) {
  const cleaned = String(value || "").trim();
  return Boolean(cleaned) && !/^(#N\/?A|N\/?A|NA|NULL|NONE|-|--|NIL)$/i.test(cleaned);
}

function normalizePatientName(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
}

function normalizePatientNameWithoutInitial(value) {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  return normalizePatientName(cleaned.replace(/\b[A-Z]\.?$/i, ""));
}

function extractProviderTaxId(providerText) {
  const parts = String(providerText || "")
    .split(/\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.reverse().find((part) => /^\d{9}$/.test(part)) || "";
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function getInputProviderTaxId(rowData = {}) {
  return digitsOnly(rowData["Provider Tax ID"] || rowData["Tax ID"] || rowData["Provider TIN"]);
}

async function selectAutocompleteOption(scope, inputLocator, value) {
  await inputLocator.click({ force: true });
  await inputLocator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await inputLocator.press("Backspace").catch(() => {});
  await inputLocator.pressSequentially(String(value || ""), { delay: 60 });
  await humanDelay(500, 1000);

  const option = scope.getByText(value, { exact: true }).last();
  let optionVisible = await option.isVisible({ timeout: 3000 }).catch(() => false);
  if (!optionVisible) {
    await humanDelay(900, 1200);
    optionVisible = await option.isVisible({ timeout: 3000 }).catch(() => false);
  }

  if (optionVisible) {
    await option.click();
  } else {
    const containingOption = scope.locator("[role='option'], [id*='-option-'], .provider-select__option").filter({ hasText: String(value || "") }).first();
    if (await containingOption.isVisible({ timeout: 2000 }).catch(() => false)) {
      await containingOption.click();
    } else {
      throw new Error(`No Availity dropdown option was found for "${value}".`);
    }
  }
}

async function getProviderInput(frame) {
  const providerLabel = frame.getByText("Select a Provider", { exact: true }).first();
  return providerLabel.locator("xpath=ancestor::*[self::div or self::label][1]/following::input[@role='combobox'][1]");
}

async function clearProviderInput(frame) {
  const providerInput = await getProviderInput(frame);
  if (!await providerInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    return;
  }

  await providerInput.click({ force: true }).catch(() => {});
  await providerInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await providerInput.press("Backspace").catch(() => {});
}

async function fillProviderTaxId(frame, taxId) {
  if (!taxId) {
    throw new Error("Molina provider Tax ID could not be extracted from selected provider value.");
  }

  const taxIdInput = frame.locator(SELECTORS.providerTaxId).first();
  await taxIdInput.waitFor({ state: "visible", timeout: 10000 });
  await taxIdInput.click({ force: true });
  await taxIdInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await taxIdInput.press("Backspace").catch(() => {});
  await taxIdInput.pressSequentially(taxId, { delay: 60 });
  await humanDelay(400, 800);

  const exactOption = frame.getByText(taxId, { exact: true }).last();
  let exactOptionVisible = await exactOption.isVisible({ timeout: 2000 }).catch(() => false);
  if (!exactOptionVisible) {
    await humanDelay(900, 1200);
    exactOptionVisible = await exactOption.isVisible({ timeout: 2000 }).catch(() => false);
  }

  if (exactOptionVisible) {
    await exactOption.click();
  } else {
    throw new Error(`Provider Tax ID dropdown has no exact option for "${taxId}".`);
  }

  await frame.waitForFunction(
    (expectedTaxId) => {
      const input = document.querySelector("input#providerTaxId");
      return input && input.value && input.value.trim() === expectedTaxId;
    },
    taxId,
    { timeout: 5000 }
  );
}

async function selectServiceDateTab(page) {
  await withRetry(
    "Selecting Molina Service Dates tab",
    async () => {
      const frame = await getClaimStatusFrame(page);
      const tab = frame.locator(SELECTORS.serviceDateTab).first();
      await tab.waitFor({ state: "visible", timeout: 10000 });
      await tab.click({ force: true });
      await humanDelay(500, 900);
    },
    { retries: 1, retryDelayMs: 1000 }
  );
}

async function selectProvider(page, providerName, rowData = {}) {
  await withRetry(
    `Selecting Molina provider ${providerName}`,
    async () => {
      const frame = await getClaimStatusFrame(page);
      const providerInput = await getProviderInput(frame);
      await providerInput.waitFor({ state: "visible", timeout: 15000 });
      await selectAutocompleteOption(frame, providerInput, providerName);

      const selectedProviderText = await providerInput.inputValue({ timeout: 3000 }).catch(() => providerName);
      await verifyProviderNpiMatches(frame, providerName, { context: "Molina Service Dates", logger });
      const providerTaxId = extractProviderTaxId(selectedProviderText || providerName) || getInputProviderTaxId(rowData);
      logger.info(`Molina provider Tax ID extracted as "${providerTaxId || "blank"}" from provider value "${selectedProviderText || providerName}".`);
      await fillProviderTaxId(frame, providerTaxId);
    },
    { retries: 2, retryDelayMs: 1200 }
  );
}

async function selectProviderOrFillTaxId(page, providerName, rowData = {}, options = {}) {
  const groupNameOnly = options.projectId === "charm" && options.providerMode === "groupNameOnly";
  const inputProviderTaxId = getInputProviderTaxId(rowData);
  const providerAsTaxId = inputProviderTaxId && digitsOnly(providerName) === inputProviderTaxId ? inputProviderTaxId : "";
  if (providerAsTaxId && !groupNameOnly) {
    logger.info(`Molina provider identifier "${providerName}" is a Tax ID. Filling Provider Tax ID directly.`);
    const frame = await clearProviderStateForTaxIdFallback(page, { context: "Molina Service Dates Tax ID fallback", logger });
    await fillProviderTaxId(frame, providerAsTaxId);
    return;
  }

  try {
    await selectProvider(page, providerName, rowData);
    return;
  } catch (error) {
    if (groupNameOnly) {
      throw error;
    }
    const taxId = inputProviderTaxId;
    if (!taxId) {
      throw error;
    }

    logger.warn(`Molina provider dropdown did not select "${providerName}". Filling Provider Tax ID "${taxId}" directly.`);
    const frame = await clearProviderStateForTaxIdFallback(page, { context: "Molina Service Dates Tax ID fallback", logger });
    await fillProviderTaxId(frame, taxId);
  }
}

async function selectRequestedStatusAll(page) {
  await withRetry(
    "Selecting Molina Requested Status ALL",
    async () => {
      const frame = await getClaimStatusFrame(page);
      const requestedStatusInput = frame.locator(SELECTORS.requestedStatus).first();
      await requestedStatusInput.waitFor({ state: "visible", timeout: 10000 });

      const currentValue = await requestedStatusInput.inputValue({ timeout: 2000 }).catch(() => "");
      if (currentValue.trim().toUpperCase() === "ALL") {
        logger.info("Molina Requested Status is already ALL.");
        return;
      }

      await selectAutocompleteOption(frame, requestedStatusInput, "ALL");
      await frame.waitForFunction(
        () => {
          const input = document.querySelector("input#requestedStatus");
          return input && input.value && input.value.trim().toUpperCase() === "ALL";
        },
        undefined,
        { timeout: 5000 }
      );
      logger.info("Molina Requested Status selected as ALL.");
    },
    { retries: 1, retryDelayMs: 1000 }
  );
}

async function getMuiDateBoxText(dateBox) {
  return dateBox.innerText({ timeout: 1000 })
    .then((text) => text.replace(/\s+/g, "").trim())
    .catch(() => "");
}

async function fillMuiDateSegments(scope, container, normalizedValue) {
  const [month, day, year] = normalizedValue.split("/");
  const keyboard = scope.page().keyboard;
  const segments = [
    { label: "Month", value: month },
    { label: "Day", value: day },
    { label: "Year", value: year }
  ];

  for (const segment of segments) {
    const segmentLocator = container.locator(`[contenteditable='true'][aria-label='${segment.label}']`).first();
    await segmentLocator.waitFor({ state: "visible", timeout: 5000 });
    await segmentLocator.click({ force: true });
    await keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await keyboard.type(segment.value);
    await humanDelay(100, 200);
  }

  await keyboard.press("Tab");
}

async function fillDateByLabel(scope, labelText, value) {
  const normalizedValue = String(value || "").trim();
  if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(normalizedValue)) {
    throw new Error(`Invalid date format for ${labelText}: "${normalizedValue}". Expected MM/DD/YYYY.`);
  }

  const label = scope.locator("label").filter({ hasText: labelText }).first();
  await label.waitFor({ state: "visible", timeout: 15000 });

  const container = label.locator(
    "xpath=ancestor::*[contains(@class,'MuiFormControl-root') or contains(@class,'MuiTextField-root') or contains(@class,'form-group')][1]"
  );
  const dateBox = container.locator("[contenteditable='false']").first();

  if (await dateBox.isVisible({ timeout: 5000 }).catch(() => false)) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await dateBox.click({ force: true });
      const keyboard = scope.page().keyboard;
      await keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await keyboard.type(normalizedValue);
      await keyboard.press("Tab");
      await humanDelay(200, 400);

      const dateText = await getMuiDateBoxText(dateBox);
      if (dateText === normalizedValue) {
        return;
      }

      logger.warn(`${labelText} did not fill completely on attempt ${attempt}: expected="${normalizedValue}", actual="${dateText}". Filling date segments directly.`);
      await fillMuiDateSegments(scope, container, normalizedValue);
      if (await getMuiDateBoxText(dateBox) === normalizedValue) {
        return;
      }
    }

    throw new Error(`${labelText} was not set correctly. Expected "${normalizedValue}", found "${await getMuiDateBoxText(dateBox)}".`);
  }

  const visibleInput = container.locator("input:not([aria-hidden='true']):visible").first();
  await visibleInput.waitFor({ state: "visible", timeout: 15000 });
  await visibleInput.click({ force: true });
  await visibleInput.fill("");
  await visibleInput.pressSequentially(normalizedValue);
  await visibleInput.press("Tab");
}

async function fillServiceDateSearchForm(page, rowData) {
  const frame = await getClaimStatusFrame(page);
  await selectRequestedStatusAll(page);
  await fillDateByLabel(frame, "Service From Date", rowData["Service Date"]);
  await humanDelay(300, 700);
  await fillDateByLabel(frame, "Service To Date", rowData["Service Date"]);
}

async function submitServiceDateSearch(page) {
  async function resultIndicatorAppeared(timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const frame = await getClaimStatusFrame(page);
      const headingVisible = await frame.locator(SELECTORS.searchResultsHeading).first().isVisible({ timeout: 500 }).catch(() => false);
      const resultRowsVisible = await frame.locator(SELECTORS.tableRows).first().isVisible({ timeout: 500 }).catch(() => false);
      const noResultsVisible = await frame.locator(SELECTORS.noResultsMessage).first().isVisible({ timeout: 500 }).catch(() => false);
      const portalResponseVisible = await frame.locator(
        "#results [role='alert'], #results .MuiAlert-root, .MuiFormHelperText-root.Mui-error, .invalid-feedback"
      ).first().isVisible({ timeout: 500 }).catch(() => false);

      if (headingVisible || resultRowsVisible || noResultsVisible || portalResponseVisible) {
        return true;
      }

      await humanDelay(800, 1200);
    }

    return false;
  }

  await withRetry(
    "Submitting Molina Service Dates search",
    async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const frame = await getClaimStatusFrame(page);
        await throwIfVisibleFieldValidation(page, "Molina Service Dates");
        const searchButton = frame.locator(SELECTORS.searchButton).first();
        await searchButton.waitFor({ state: "visible", timeout: 15000 });
        await searchButton.scrollIntoViewIfNeeded().catch(() => {});
        await searchButton.click({ force: attempt > 1 });
        logger.info(`Molina Service Dates Search clicked (attempt ${attempt}/3). Waiting for portal response.`);
        await humanDelay(1500, 2500);

        if (await resultIndicatorAppeared(5000)) {
          logger.info(`Molina Service Dates search response appeared after submit attempt ${attempt}.`);
          return;
        }

        if (attempt < 3) {
          logger.warn(`Molina Service Dates search results did not appear within 5 seconds after submit attempt ${attempt}. Re-clicking Search.`);
        }
      }

      throw new Error("Molina Service Dates Search did not produce results, no-results message, or validation response after 3 attempts.");
    },
    { retries: 1, retryDelayMs: 1200 }
  );
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

function cellByAnyHeader(cells, headers, headerNames) {
  for (const headerName of headerNames) {
    const value = cellByHeader(cells, headers, headerName);
    if (value) {
      return value;
    }
  }

  return "";
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

async function getMolinaServiceDateRows(page) {
  const frame = await getClaimStatusFrame(page);
  const headers = await readColumnHeaders(frame);
  const rows = frame.locator(SELECTORS.tableRows);
  const count = await rows.count();
  const results = [];

  for (let index = 0; index < count; index += 1) {
    const row = rows.nth(index);
    const cells = await row.locator("td").evaluateAll((nodes) => nodes.map((node) => node.textContent || "")).catch(() => []);
    const normalizedCells = cells.map((cell) => cell.replace(/\s+/g, " ").trim());
    if (normalizedCells.length < 2) {
      continue;
    }

    const statusText = await row.locator(".badge").first().innerText({ timeout: 1000 }).catch(() => cellByHeader(normalizedCells, headers, "status"));
    const finalizedDate = cellByHeader(normalizedCells, headers, "finalized date");
    results.push({
      index,
      row,
      cells: normalizedCells,
      serviceDate: normalizeDateText(cellByHeader(normalizedCells, headers, "service dates")),
      billedAmount: cellByHeader(normalizedCells, headers, "billed amount"),
      claimNumber: cellByHeader(normalizedCells, headers, "claim number"),
      memberId: cellByAnyHeader(normalizedCells, headers, ["member id", "patient member id"]),
      patientName: cellByAnyHeader(normalizedCells, headers, ["patient name", "member name", "patient", "member"]),
      patientId: cellByAnyHeader(normalizedCells, headers, ["patient account number", "patient id", "patient number"]),
      finalizedDate: normalizeDateText(finalizedDate),
      finalizedDateValue: parseDateValue(finalizedDate),
      status: normalizeStatus(statusText)
    });
  }

  return results;
}

function selectMolinaMatchedRows(matchedRows, sourceTab) {
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

async function extractMolinaMatchedRow(page, matchedRow, sourceTab) {
  logger.info(
    `Preparing to extract Molina matched row: claim="${matchedRow.claimNumber}", status="${matchedRow.status.display}", service_date="${matchedRow.serviceDate}", billed="${matchedRow.billedAmount}", member_id="${matchedRow.memberId}"`
  );

  if (matchedRow.status.type === "unsupported") {
    return {
      type: "unsupported",
      claimNumber: matchedRow.claimNumber,
      claimStatus: matchedRow.status.display
    };
  }

  await matchedRow.row.click();
  logger.info(`Clicked Molina matched result row for claim ${matchedRow.claimNumber}. Waiting for detail page.`);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await waitForClaimDetailPage(page);
  logger.success(`Molina detail page loaded for claim ${matchedRow.claimNumber}`);

  if (matchedRow.status.type === "in_process") {
    const extracted = await extractInProcess(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  if (matchedRow.status.type === "paid") {
    const extracted = await extractMolinaPaid(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  if (matchedRow.status.type === "denied") {
    const extracted = await extractMolinaDenied(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  return {
    type: "unsupported",
    claimNumber: matchedRow.claimNumber,
    claimStatus: matchedRow.status.display
  };
}

async function searchMolinaServiceDatesWithProvider(page, providerName, rowData, options = {}) {
  logger.info(`Molina Service Dates provider attempt: ${providerName}`);
  await selectServiceDateTab(page);
  const charmContext = "Charm Molina Service Dates";
  if (await trySubmitCharmSearchWithoutProviderDropdown(page, rowData, {
    projectId: options.projectId,
    context: charmContext,
    logger,
    providerMode: options.providerMode,
    fillSearchForm: fillServiceDateSearchForm,
    submitSearch: submitServiceDateSearch,
  })) return;
  if (options.projectId === "charm" && options.providerMode === "none") {
    throw new Error(`${charmContext} providerMode "none" skips Select a Provider, but required provider fields could not be filled directly from claim data.`);
  }
  await selectProviderOrFillTaxId(page, providerName, rowData, options);
  if (await submitCharmSearchAfterProviderDropdown(page, rowData, {
    projectId: options.projectId,
    context: charmContext,
    logger,
    providerMode: options.providerMode,
    providerDropdownSelected: true,
    fillSearchForm: fillServiceDateSearchForm,
    submitSearch: submitServiceDateSearch,
  })) return;
  await fillServiceDateSearchForm(page, rowData);
  await submitServiceDateSearch(page);
}

module.exports = createServiceDateWorkflow({
  name: "molina",
  payerLabel: "Molina",
  searchWithProvider: searchMolinaServiceDatesWithProvider,
  readResultRows: getMolinaServiceDateRows,
  selectMatchedRows: selectMolinaMatchedRows,
  extractMatchedRow: extractMolinaMatchedRow,
});



