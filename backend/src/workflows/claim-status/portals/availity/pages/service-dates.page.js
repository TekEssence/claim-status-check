"use strict";

const logger = require("../utils/logger");
const { humanDelay, withRetry } = require("../utils/browser");
const { getClaimStatusFrame } = require("./navigation.page");
const { submitCharmSearchWithProvider } = require("./charm-provider-search.page");
const { PROVIDERS } = require("./claim-status-member.page");
const { waitForSearchResultsToSettle, normalizeDateText, throwIfVisibleFieldValidation } = require("./results.page");
const { renderFailedSummary } = require("../services/summary-renderer");
const { normalizeStatus } = require("../services/status-normalizer");

const SERVICE_DATE_SELECTORS = {
  serviceDateTab: "button[role='tab']:has-text('Service Dates'), a[role='button']:has-text('Service Dates')",
  providerNpiRadio: "input[name='providerIdentifier'][value='npi']",
  providerNpi: "input#providerNpi[name='providerNpi']",
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

async function selectAutocompleteOption(scope, inputLocator, value) {
  await inputLocator.click({ force: true });
  await inputLocator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await inputLocator.press("Backspace").catch(() => {});
  await inputLocator.pressSequentially(String(value || ""), { delay: 60 });
  await humanDelay(500, 1000);

  const option = scope.getByText(value, { exact: true }).last();
  if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
    await option.click();
    return;
  }

  const containingOption = scope.locator("[role='option'], [id*='-option-'], .provider-select__option").filter({ hasText: String(value || "") }).first();
  if (await containingOption.isVisible({ timeout: 2000 }).catch(() => false)) {
    await containingOption.click();
    return;
  }

  throw new Error(`No Availity dropdown option was found for "${value}".`);
}

async function selectServiceDateTab(page, payerLabel = "Availity") {
  await withRetry(
    `Selecting ${payerLabel} Service Dates tab`,
    async () => {
      const frame = await getClaimStatusFrame(page);
      const tab = frame.locator(SERVICE_DATE_SELECTORS.serviceDateTab).first();
      await tab.waitFor({ state: "visible", timeout: 10000 });
      await tab.click({ force: true });
      await humanDelay(500, 900);
    },
    { retries: 1, retryDelayMs: 1000 }
  );
}

async function selectServiceDateProvider(page, providerName, payerLabel = "Availity") {
  await withRetry(
    `Selecting ${payerLabel} provider ${providerName}`,
    async () => {
      const frame = await getClaimStatusFrame(page);
      const providerLabel = frame.getByText("Select a Provider", { exact: true }).first();
      const providerInput = providerLabel.locator("xpath=ancestor::*[self::div or self::label][1]/following::input[@role='combobox'][1]");
      await providerInput.waitFor({ state: "visible", timeout: 15000 });
      await selectAutocompleteOption(frame, providerInput, providerName);

      const npiRadio = frame.locator(SERVICE_DATE_SELECTORS.providerNpiRadio).first();
      if (await npiRadio.isVisible({ timeout: 3000 }).catch(() => false)) {
        const isChecked = await npiRadio.isChecked({ timeout: 500 }).catch(() => false);
        if (!isChecked) {
          await npiRadio.setChecked(true, { force: true }).catch(async () => {
            await frame.getByText("Provider NPI", { exact: true }).click({ force: true });
          });
        }
      }

      await frame.waitForFunction(
        () => {
          const input = document.querySelector("input#providerNpi[name='providerNpi']");
          return input && input.value && input.value.trim().length > 0;
        },
        null,
        { timeout: 10000 }
      );
    },
    { retries: 2, retryDelayMs: 1200 }
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
  await fillDateByLabel(frame, "Service From Date", rowData["Service Date"]);
  await humanDelay(300, 700);
  await fillDateByLabel(frame, "Service To Date", rowData["Service Date"]);
}

async function submitServiceDateSearch(page, payerLabel = "Availity") {
  async function resultIndicatorAppeared(timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const frame = await getClaimStatusFrame(page);
      const headingVisible = await frame.locator(SERVICE_DATE_SELECTORS.searchResultsHeading).first().isVisible({ timeout: 500 }).catch(() => false);
      const resultRowsVisible = await frame.locator(SERVICE_DATE_SELECTORS.tableRows).first().isVisible({ timeout: 500 }).catch(() => false);
      const noResultsVisible = await frame.locator(SERVICE_DATE_SELECTORS.noResultsMessage).first().isVisible({ timeout: 500 }).catch(() => false);
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
    `Submitting ${payerLabel} Service Dates search`,
    async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const frame = await getClaimStatusFrame(page);
        await throwIfVisibleFieldValidation(page, `${payerLabel} Service Dates`);
        const searchButton = frame.locator(SERVICE_DATE_SELECTORS.searchButton).first();
        await searchButton.waitFor({ state: "visible", timeout: 15000 });
        await searchButton.scrollIntoViewIfNeeded().catch(() => {});
        await searchButton.click({ force: attempt > 1 });
        logger.info(`${payerLabel} Service Dates Search clicked (attempt ${attempt}/3). Waiting for portal response.`);
        await humanDelay(1500, 2500);

        if (await resultIndicatorAppeared(5000)) {
          logger.info(`${payerLabel} Service Dates search response appeared after submit attempt ${attempt}.`);
          return;
        }

        if (attempt < 3) {
          logger.warn(`${payerLabel} Service Dates search results did not appear within 5 seconds after submit attempt ${attempt}. Re-clicking Search.`);
        }
      }

      throw new Error(`${payerLabel} Service Dates Search did not produce results, no-results message, or validation response after 3 attempts.`);
    },
    { retries: 1, retryDelayMs: 1200 }
  );
}

async function searchServiceDatesWithProvider(page, providerName, rowData, options = {}) {
  const payerLabel = options.payerLabel || "Availity";
  logger.info(`${payerLabel} Service Dates provider attempt: ${providerName}`);
  await selectServiceDateTab(page, payerLabel);
  const selectProvider = (targetPage, targetProviderName) => selectServiceDateProvider(targetPage, targetProviderName, payerLabel);
  const submitSearch = (targetPage) => submitServiceDateSearch(targetPage, payerLabel);
  if (await submitCharmSearchWithProvider(page, providerName, rowData, {
    projectId: options.projectId,
    context: `Charm ${payerLabel} Service Dates`,
    logger,
    providerMode: options.providerMode,
    selectProvider,
    fillSearchForm: fillServiceDateSearchForm,
    submitSearch,
  })) return;
  await selectProvider(page, providerName);
  await fillServiceDateSearchForm(page, rowData);
  await submitSearch(page);
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

async function readServiceDateResultRows(page) {
  const frame = await getClaimStatusFrame(page);
  const headers = await readColumnHeaders(frame);
  const rows = frame.locator(SERVICE_DATE_SELECTORS.tableRows);
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

async function processServiceDateProviderLoop(page, row, options = {}) {
  const payerLabel = options.payerLabel || "Availity";
  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : PROVIDERS;

  let lastProviderFailure = "";
  for (const provider of providerOrder) {
    await searchServiceDatesWithProvider(page, provider, row.data, {
      ...options,
      payerLabel
    });

    logger.info(`Waiting up to 5 seconds for ${provider} ${payerLabel} Service Dates results to settle`);
    const resultSummary = await waitForSearchResultsToSettle(page, 5000);
    logger.info(
      `${payerLabel} Service Dates provider ${provider} result summary: heading="${resultSummary.headingText || "not found"}", total=${resultSummary.total ?? "unknown"}, rows=${resultSummary.resultRowCount ?? "unknown"}, no_results_message=${resultSummary.noResultsMessageVisible}, alert="${resultSummary.portalAlertMessage || ""}"`
    );

    const resultRows = await readServiceDateResultRows(page);
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

    return options.processResults(page, row, provider, resultSummary, {
      ...options,
      resultRows
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
      : `Searched ${payerLabel} Service Dates providers: ${providerOrder.join(", ")}. No matching Service Date + Charges + Member ID found.`
  };
}

module.exports = {
  SERVICE_DATE_SELECTORS,
  fillServiceDateSearchForm,
  hasUsableValue,
  normalizeMemberId,
  normalizePatientName,
  normalizePatientNameWithoutInitial,
  processServiceDateProviderLoop,
  readServiceDateResultRows,
  searchServiceDatesWithProvider,
  selectServiceDateProvider,
  selectServiceDateTab,
  submitServiceDateSearch
};
