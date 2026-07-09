"use strict";

const logger = require("../utils/logger");
const { humanDelay, withRetry } = require("../utils/browser");
const { getClaimStatusFrame } = require("./navigation.page");

const PROVIDERS = ["TRINITY PAIN MANAGEMENT", "DAO, THUAN DUC"];

const SELECTORS = {
  payerInput: "input#payer[role='combobox']",
  selectedPayerInput: "input#payerSelect[role='combobox']",
  memberTab: "button[role='tab']:has-text('Member')",
  providerLabel: "text=Select a Provider",
  providerCombobox: "input[role='combobox'][placeholder='Select...']",
  providerNpi: "input#providerNpi[name='providerNpi']",
  memberId: "input#memberId[name='memberId']",
  groupNumber: "input#groupNumber[name='groupNumber']",
  searchButton: "button#submit-byMember[type='submit']",
  searchResultsHeading: "h5:has-text('Search Results')",
  tableRows: "tbody tr",
  noResultsMessage: "li:has-text('The payer could not find any results based on your search')",
  portalAlert: "[role='alert'], .MuiAlert-root"
};

async function selectAutocompleteOption(scope, inputLocator, value) {
  await inputLocator.click();
  await inputLocator.fill(value);
  await humanDelay(500, 1000);
  const option = scope.getByText(value, { exact: true }).last();
  if (await option.isVisible().catch(() => false)) {
    await option.click();
  } else {
    await inputLocator.press("Enter");
  }
}

async function isPayerSelectionCommitted(frame, payerName) {
  const selected = await frame.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const expectedValue = normalize(expected);
    const values = [
      document.querySelector("input#payerSelect[role='combobox']")?.value,
      document.querySelector("#payerSelect .payer-select__single-value")?.textContent,
      document.querySelector(".payer-select__single-value")?.textContent,
      document.querySelector("input[name='payer']")?.value
    ].map(normalize).filter(Boolean);

    return values.some((value) => value === expectedValue);
  }, payerName).catch(() => false);

  return Boolean(selected);
}

async function clickExactPayerOption(frame, payerName) {
  const clicked = await frame.evaluate((expected) => {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
    const expectedValue = normalize(expected);
    const candidates = Array.from(document.querySelectorAll("[role='option'], [id*='option'], .payer-select__option"));
    const exactOption = candidates.find((element) => normalize(element.textContent) === expectedValue);

    if (!exactOption) {
      return false;
    }

    exactOption.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    exactOption.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    exactOption.click();
    return true;
  }, payerName).catch(() => false);

  return Boolean(clicked);
}

async function selectPayerAutocompleteOption(frame, inputLocator, payerName) {
  await inputLocator.click({ force: true });
  await inputLocator.fill("");
  await inputLocator.fill(payerName);
  await humanDelay(800, 1200);

  const fallbackOption = frame.getByText(payerName, { exact: true }).last();
  if (await clickExactPayerOption(frame, payerName)) {
    logger.info(`Clicked exact payer dropdown option: ${payerName}`);
  } else if (await fallbackOption.isVisible({ timeout: 3000 }).catch(() => false)) {
    await fallbackOption.click();
  } else {
    throw new Error(`Exact payer option was not visible in dropdown: ${payerName}`);
  }

  await humanDelay(500, 900);

  if (!(await isPayerSelectionCommitted(frame, payerName))) {
    logger.warn(`Payer ${payerName} was clicked but not verified as selected. Pressing Enter once to commit exact typed value.`);
    await inputLocator.press("Enter").catch(() => {});
    await humanDelay(500, 900);
  }

  if (!(await isPayerSelectionCommitted(frame, payerName))) {
    throw new Error(`Payer ${payerName} was not committed after dropdown selection.`);
  }
}

async function scrollClaimStatusFrameToTop(page) {
  const frame = await getClaimStatusFrame(page);
  await frame.evaluate(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;

    const scrollableElements = Array.from(document.querySelectorAll("*")).filter((element) => {
      const style = window.getComputedStyle(element);
      return /(auto|scroll)/.test(`${style.overflow}${style.overflowY}`) && element.scrollHeight > element.clientHeight;
    });

    scrollableElements.forEach((element) => {
      element.scrollTop = 0;
    });
  }).catch(() => {});
  await humanDelay(500, 900);
}

async function selectPayer(page, payerName) {
  await withRetry(
    `Selecting payer ${payerName}`,
    async () => {
      await scrollClaimStatusFrameToTop(page);
      const frame = await getClaimStatusFrame(page);
      const selectedPayerInput = frame.locator(SELECTORS.selectedPayerInput).first();
      const emptyPayerInput = frame.locator(SELECTORS.payerInput).first();
      const payerInput = await selectedPayerInput.isVisible({ timeout: 2000 }).catch(() => false)
        ? selectedPayerInput
        : emptyPayerInput;

      await payerInput.waitFor({ state: "visible", timeout: 30000 });
      await payerInput.scrollIntoViewIfNeeded().catch(() => {});
      await payerInput.click({ force: true });
      await payerInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await payerInput.press("Backspace");
      await payerInput.fill("");
      await selectPayerAutocompleteOption(frame, payerInput, payerName);
    },
    { retries: 2, retryDelayMs: 1200 }
  );
}

async function selectMemberTab(page) {
  await withRetry(
    "Selecting Member tab",
    async () => {
      const frame = await getClaimStatusFrame(page);
      await frame.locator(SELECTORS.memberTab).first().waitFor({ state: "visible", timeout: 5000 });
      await frame.click(SELECTORS.memberTab);
      await frame.waitForSelector(`${SELECTORS.memberTab}[aria-selected='true']`, { timeout: 10000 }).catch(() => {});
    },
    { retries: 1, retryDelayMs: 1000 }
  );
}

async function selectProvider(page, providerName) {
  await withRetry(
    `Selecting provider ${providerName}`,
    async () => {
      const frame = await getClaimStatusFrame(page);
      const providerLabel = frame.getByText("Select a Provider", { exact: true }).first();
      const providerInput = providerLabel.locator("xpath=ancestor::*[self::div or self::label][1]/following::input[@role='combobox'][1]");
      await providerInput.waitFor({ state: "visible", timeout: 15000 });
      await selectAutocompleteOption(frame, providerInput, providerName);
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

async function fillTextField(scope, selector, value) {
  await scope.locator(selector).fill("");
  await scope.locator(selector).fill(String(value || ""));
}

function normalizeGroupNumber(value) {
  return String(value || "").trim().slice(0, 6);
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

      // The MUI date picker focuses the visible segmented field after click.
      // Use the page keyboard because locator key actions can hang on the inner Month span.
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
      const segmentedDateText = await getMuiDateBoxText(dateBox);
      if (segmentedDateText === normalizedValue) {
        return;
      }
    }

    const finalText = await getMuiDateBoxText(dateBox);
    throw new Error(`${labelText} was not set correctly. Expected "${normalizedValue}", found "${finalText}".`);
  }

  const visibleInput = container.locator("input:not([aria-hidden='true']):visible").first();
  await visibleInput.waitFor({ state: "visible", timeout: 15000 });
  await visibleInput.click({ force: true });
  await visibleInput.fill("");
  await visibleInput.pressSequentially(normalizedValue);
  await visibleInput.press("Tab");
}

async function ensureToDate(scope, serviceDate) {
  await fillDateByLabel(scope, "Service To Date", serviceDate);
}

async function fillMemberSearchForm(page, rowData) {
  const frame = await getClaimStatusFrame(page);
  const groupNumber = normalizeGroupNumber(rowData["Group No"]);
  await fillTextField(frame, SELECTORS.memberId, rowData["Subscriber No"]);
  await fillTextField(frame, SELECTORS.groupNumber, groupNumber);
  await fillDateByLabel(frame, "Service From Date", rowData["Service Date"]);
  await humanDelay(300, 700);
  await ensureToDate(frame, rowData["Service Date"]);
}

async function submitMemberSearch(page) {
  async function resultIndicatorAppeared(timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const frame = await getClaimStatusFrame(page);
      const headingVisible = await frame.locator(SELECTORS.searchResultsHeading).first().isVisible({ timeout: 500 }).catch(() => false);
      const resultRowsVisible = await frame.locator(SELECTORS.tableRows).first().isVisible({ timeout: 500 }).catch(() => false);
      const noResultsVisible = await frame.locator(SELECTORS.noResultsMessage).first().isVisible({ timeout: 500 }).catch(() => false);

      if (headingVisible || resultRowsVisible || noResultsVisible) {
        return true;
      }

      await humanDelay(800, 1200);
    }

    return false;
  }

  await withRetry(
    "Submitting Member search",
    async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const frame = await getClaimStatusFrame(page);
        const searchButton = frame.locator(SELECTORS.searchButton).first();
        await searchButton.waitFor({ state: "visible", timeout: 15000 });
        await searchButton.scrollIntoViewIfNeeded().catch(() => {});
        await searchButton.click({ force: attempt > 1 });
        logger.info(`Member Search clicked (attempt ${attempt}/3). Waiting for portal response.`);
        await humanDelay(1500, 2500);

        if (await resultIndicatorAppeared(5000)) {
          logger.info(`Member search response appeared after submit attempt ${attempt}.`);
          return;
        }

        if (attempt < 3) {
          logger.warn(`Member search results did not appear within 5 seconds after submit attempt ${attempt}. Re-clicking Search.`);
        }
      }

      throw new Error("Member Search did not produce results, no-results message, or validation response after 3 attempts.");
    },
    { retries: 1, retryDelayMs: 1200 }
  );
}

async function hasNoResults(page) {
  const frame = await getClaimStatusFrame(page);
  return frame.locator(SELECTORS.noResultsMessage).isVisible().catch(() => false);
}

async function searchMemberWithProvider(page, providerName, rowData) {
  logger.info(`Member search provider attempt: ${providerName}`);
  await selectMemberTab(page);
  await selectProvider(page, providerName);
  await fillMemberSearchForm(page, rowData);
  await submitMemberSearch(page);
}

module.exports = {
  PROVIDERS,
  SELECTORS,
  hasNoResults,
  searchMemberWithProvider,
  selectPayer
};
