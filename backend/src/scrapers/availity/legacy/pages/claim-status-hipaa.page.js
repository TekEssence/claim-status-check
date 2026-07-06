"use strict";

const logger = require("../utils/logger");
const { humanDelay, withRetry } = require("../utils/browser");
const { getClaimStatusFrame } = require("./navigation.page");

const HIPAA_SELECTORS = {
  hipaaTab: "button[role='tab']:has-text('HIPAA Standard')",
  hipaaAnchorTab: "a[id='HIPAA Standard'][role='button'], a[role='button']:has-text('HIPAA Standard')",
  memberTab: "button[role='tab']:has-text('Member')",
  memberAnchorTab: "a#Member[role='button'], a[role='button']:has-text('Member')",
  providerInput: "input#providerExpressEntry[role='combobox']",
  providerControl: "#providerSelect .provider-select__control",
  providerSelectedValue: "#providerSelect .provider-select__single-value",
  providerDropdownIndicator: "#providerSelect .provider-select__dropdown-indicator",
  memberId: "input#patientMemberId, input#subscriberMemberId",
  patientFirstName: "input#patientFirstName",
  patientLastName: "input#patientLastName",
  patientDob: "input#patientBirthDate",
  patientIsSubscriber: "input[id^='patientIsSubscriber-'][type='checkbox']",
  serviceFromDate: "input#serviceDates-start",
  serviceToDate: "input#serviceDates-end",
  submitButton: "button[type='submit'][data-analytics-form-name='HIPAA Standard']",
  resultsHeading: "span:has-text('Results (Displaying'), h5:has-text('Search Results'), h5:has-text('Results (Displaying')",
  noResultsMessage: "li:has-text('The payer could not find any results based on your search')",
  portalAlert: "[role='alert'], .MuiAlert-root"
};

function splitPatientName(patientName) {
  const raw = String(patientName || "").replace(/\s+/g, " ").trim();
  const parts = raw.split(",");

  if (parts.length < 2) {
    return {
      firstName: "",
      lastName: raw
    };
  }

  const firstNameParts = parts.slice(1).join(",").trim().split(/\s+/).filter(Boolean);
  if (firstNameParts.length > 1 && /^[A-Za-z]\.?$/.test(firstNameParts[firstNameParts.length - 1])) {
    firstNameParts.pop();
  }

  return {
    lastName: parts[0].trim(),
    firstName: firstNameParts.join(" ")
  };
}

async function selectAutocompleteOption(scope, inputLocator, value) {
  await inputLocator.scrollIntoViewIfNeeded().catch(() => {});
  await inputLocator.click({ force: true });
  await inputLocator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await inputLocator.press("Backspace").catch(() => {});
  await inputLocator.fill(String(value || ""));
  await humanDelay(500, 1000);

  const option = scope.getByText(value, { exact: true }).last();
  if (await option.isVisible({ timeout: 3000 }).catch(() => false)) {
    await option.click();
  } else {
    await inputLocator.press("Enter");
  }
}

async function getSelectedProviderText(frame) {
  const muiInput = await getProviderInput(frame).catch(() => null);
  const muiValue = muiInput ? await muiInput.inputValue({ timeout: 1000 }).catch(() => "") : "";
  if (muiValue) {
    return muiValue;
  }

  const reactSelectValue = await frame.locator(HIPAA_SELECTORS.providerSelectedValue).first().innerText({ timeout: 1000 }).catch(() => "");
  return reactSelectValue || "";
}

async function getProviderFieldState(frame) {
  const input = await getProviderInput(frame).catch(() => null);
  const inputValue = input ? await input.inputValue({ timeout: 1000 }).catch(() => "") : "";
  const selectedText = await frame.locator(HIPAA_SELECTORS.providerSelectedValue).first().innerText({ timeout: 1000 }).catch(() => "");
  const hiddenValue = await frame.locator("input[name='providerExpressEntry']").first().inputValue({ timeout: 1000 }).catch(() => "");
  const providerNpi = await frame.locator("input#providerNpi[name='providerNpi'], input[name='providerNpi']").first().inputValue({ timeout: 1000 }).catch(() => "");

  return {
    inputValue: inputValue.trim(),
    selectedText: selectedText.trim(),
    hiddenValue: hiddenValue.trim(),
    providerNpi: providerNpi.trim()
  };
}

function providerStateMatchesProvider(state, providerName) {
  const expected = String(providerName || "").trim().toUpperCase();
  const selectedText = String(state.selectedText || "").trim().toUpperCase();
  const hiddenValue = String(state.hiddenValue || "").trim();
  const inputValue = String(state.inputValue || "").trim().toUpperCase();
  const inputHasProviderIdentifier = /\d{10}/.test(state.inputValue || "");
  const npiHasProviderIdentifier = /\d{10}/.test(state.providerNpi || "");

  // Typed text in the combobox is not enough. React Select keeps a hidden
  // provider value only after an option is actually selected. The MUI variant
  // confirms selection by replacing typed text with provider + NPI/Tax ID.
  return Boolean(
    expected
      && (
        (selectedText.includes(expected) && hiddenValue)
        || (inputValue.includes(expected) && (inputHasProviderIdentifier || npiHasProviderIdentifier))
      )
  );
}

async function waitForProviderSelection(frame, providerName, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = null;

  while (Date.now() < deadline) {
    lastState = await getProviderFieldState(frame);

    if (providerStateMatchesProvider(lastState, providerName)) {
      return lastState;
    }

    await humanDelay(400, 700);
  }

  const stateText = lastState
    ? `input="${lastState.inputValue}", selected="${lastState.selectedText}", hidden="${lastState.hiddenValue}", npi="${lastState.providerNpi}"`
    : "state unavailable";
  throw new Error(`HIPAA provider selection was not verified after ${timeoutMs} ms: ${stateText}`);
}

async function clickProviderOption(frame, providerName) {
  const providerText = String(providerName || "").trim();
  const deadline = Date.now() + 8000;
  let lastVisibleOptions = "";

  while (Date.now() < deadline) {
    const optionLocators = [
      frame.locator(`[id^='react-select-'][id*='-option-']:has-text("${providerText}")`).last(),
      frame.locator(`[role='option']:has-text("${providerText}")`).last(),
      frame.locator(`.provider-select__menu *:has-text("${providerText}")`).last()
    ];

    for (const option of optionLocators) {
      if (await option.isVisible({ timeout: 500 }).catch(() => false)) {
        await option.click({ force: true });
        await humanDelay(300, 600);
        return;
      }
    }

    lastVisibleOptions = await frame.locator("[role='option'], .provider-select__menu *")
      .evaluateAll((elements) => elements
        .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .slice(0, 10)
        .join(" | "))
      .catch(() => "");

    await humanDelay(500, 800);
  }

  throw new Error(`HIPAA provider option not visible after typing: ${providerName}. Visible provider options: ${lastVisibleOptions || "none"}`);
}

async function getProviderInput(frame) {
  const oldHipaaInput = frame.locator(HIPAA_SELECTORS.providerInput).first();
  if (await oldHipaaInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    return oldHipaaInput;
  }

  const providerLabel = frame.locator("label").filter({ hasText: "Select a Provider" }).last();
  const muiProviderInput = providerLabel.locator("xpath=ancestor::*[contains(@class,'MuiFormControl-root')][1]//input[@role='combobox']").first();
  await muiProviderInput.waitFor({ state: "visible", timeout: 15000 });
  return muiProviderInput;
}

async function clickProviderDropdown(frame, providerInput) {
  const oldDropdownIndicator = frame.locator(HIPAA_SELECTORS.providerDropdownIndicator).first();
  if (await oldDropdownIndicator.isVisible({ timeout: 1000 }).catch(() => false)) {
    await oldDropdownIndicator.click({ force: true });
    return;
  }

  const oldProviderControl = frame.locator(HIPAA_SELECTORS.providerControl).first();
  if (await oldProviderControl.isVisible({ timeout: 1000 }).catch(() => false)) {
    await oldProviderControl.click({ force: true });
    return;
  }

  const muiOpenButton = providerInput.locator("xpath=ancestor::*[contains(@class,'MuiFormControl-root')][1]//button[@aria-label='Open']").first();
  if (await muiOpenButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await muiOpenButton.click({ force: true });
    return;
  }

  await providerInput.click({ force: true });
}

async function isMemberTabAvailable(page) {
  const frame = await getClaimStatusFrame(page);
  const muiTabVisible = await frame.locator(HIPAA_SELECTORS.memberTab).first().isVisible({ timeout: 1500 }).catch(() => false);
  const anchorTabVisible = await frame.locator(HIPAA_SELECTORS.memberAnchorTab).first().isVisible({ timeout: 1500 }).catch(() => false);
  return muiTabVisible || anchorTabVisible;
}

async function isHipaaTabAvailable(page) {
  const frame = await getClaimStatusFrame(page);
  const muiTabVisible = await frame.locator(HIPAA_SELECTORS.hipaaTab).first().isVisible({ timeout: 1500 }).catch(() => false);
  const anchorTabVisible = await frame.locator(HIPAA_SELECTORS.hipaaAnchorTab).first().isVisible({ timeout: 1500 }).catch(() => false);
  return muiTabVisible || anchorTabVisible;
}

async function waitForSearchTabs(page, timeoutMs = 5000, options = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastAvailability = {
    memberAvailable: false,
    hipaaAvailable: false
  };

  while (Date.now() < deadline) {
    const frame = await getClaimStatusFrame(page);
    const memberAvailable = await frame.locator(`${HIPAA_SELECTORS.memberTab}, ${HIPAA_SELECTORS.memberAnchorTab}`).first().isVisible({ timeout: 700 }).catch(() => false);
    const hipaaAvailable = await frame.locator(`${HIPAA_SELECTORS.hipaaTab}, ${HIPAA_SELECTORS.hipaaAnchorTab}`).first().isVisible({ timeout: 700 }).catch(() => false);

    lastAvailability = {
      memberAvailable,
      hipaaAvailable
    };

    if (options.preferMember && memberAvailable) {
      return lastAvailability;
    }

    if (options.preferHipaa && hipaaAvailable) {
      return lastAvailability;
    }

    if (!options.preferMember && !options.preferHipaa && (memberAvailable || hipaaAvailable)) {
      return lastAvailability;
    }

    await humanDelay(800, 1200);
  }

  return lastAvailability;
}

async function selectHipaaTab(page) {
  await withRetry(
    "Selecting HIPAA Standard tab",
    async () => {
      const frame = await getClaimStatusFrame(page);
      const muiTab = frame.locator(HIPAA_SELECTORS.hipaaTab).first();
      const anchorTab = frame.locator(HIPAA_SELECTORS.hipaaAnchorTab).first();
      const tab = await muiTab.isVisible({ timeout: 3000 }).catch(() => false) ? muiTab : anchorTab;
      await tab.waitFor({ state: "visible", timeout: 5000 });
      await tab.click();
      await frame.waitForSelector(`${HIPAA_SELECTORS.hipaaTab}[aria-selected='true']`, { timeout: 10000 }).catch(() => {});
      await Promise.race([
        frame.locator(HIPAA_SELECTORS.memberId).first().waitFor({ state: "visible", timeout: 20000 }),
        frame.locator(HIPAA_SELECTORS.providerInput).first().waitFor({ state: "attached", timeout: 20000 }),
        frame.locator(HIPAA_SELECTORS.submitButton).first().waitFor({ state: "visible", timeout: 20000 })
      ]);
    },
    { retries: 1, retryDelayMs: 1000 }
  );
}

async function selectProvider(page, providerName) {
  await withRetry(
    `Selecting HIPAA provider ${providerName}`,
    async () => {
      const frame = await getClaimStatusFrame(page);
      await frame.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      await humanDelay(300, 700);

      const providerInput = await getProviderInput(frame);

      const currentState = await getProviderFieldState(frame);
      logger.info(
        `HIPAA provider current state before select: input="${currentState.inputValue}", selected="${currentState.selectedText}", hidden="${currentState.hiddenValue}", npi="${currentState.providerNpi}"`
      );
      if (providerStateMatchesProvider(currentState, providerName)) {
        logger.info(`HIPAA provider ${providerName} already selected and verified`);
        return;
      }

      await clickProviderDropdown(frame, providerInput);

      await humanDelay(300, 700);
      await providerInput.evaluate((input) => input.focus()).catch(() => {});
      await frame.page().keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await frame.page().keyboard.press("Backspace");
      await frame.page().keyboard.type(String(providerName));
      await humanDelay(700, 1200);
      await clickProviderOption(frame, providerName);

      const selectedState = await waitForProviderSelection(frame, providerName, 10000);
      logger.info(
        `HIPAA provider selected state after select: input="${selectedState.inputValue}", selected="${selectedState.selectedText}", hidden="${selectedState.hiddenValue}", npi="${selectedState.providerNpi}"`
      );
    },
    { retries: 2, retryDelayMs: 1200 }
  );
}

async function fillTextField(scope, selector, value) {
  const field = scope.locator(selector).first();
  await field.waitFor({ state: "visible", timeout: 15000 });
  await field.fill("");
  await field.fill(String(value || ""));
}

async function getMuiDateBoxText(dateBox) {
  return dateBox.innerText({ timeout: 1000 })
    .then((text) => text.replace(/\s+/g, "").trim())
    .catch(() => "");
}

async function fillMuiDateByLabel(scope, labelText, value) {
  const normalizedValue = String(value || "").trim();
  const [month, day, year] = normalizedValue.split("/");
  const label = scope.locator("label").filter({ hasText: labelText }).first();
  await label.waitFor({ state: "visible", timeout: 15000 });

  const container = label.locator("xpath=ancestor::*[contains(@class,'MuiFormControl-root')][1]");
  const dateBox = container.locator("[contenteditable='false']").first();
  await dateBox.waitFor({ state: "visible", timeout: 15000 });

  const segments = [
    { label: "Month", value: month },
    { label: "Day", value: day },
    { label: "Year", value: year }
  ];

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    for (const segment of segments) {
      const segmentLocator = container.locator(`[contenteditable='true'][aria-label='${segment.label}']`).first();
      await segmentLocator.waitFor({ state: "visible", timeout: 5000 });
      await segmentLocator.fill(segment.value);
      await humanDelay(100, 200);
    }

    await scope.page().keyboard.press("Tab");
    await humanDelay(250, 500);

    const actualValue = await getMuiDateBoxText(dateBox);
    if (actualValue === normalizedValue) {
      return;
    }

    logger.warn(`HIPAA ${labelText} value mismatch after MUI fill attempt ${attempt}: expected="${normalizedValue}", actual="${actualValue}". Retrying.`);
  }

  const finalValue = await getMuiDateBoxText(dateBox);
  if (finalValue !== normalizedValue) {
    throw new Error(`HIPAA ${labelText} was not set correctly. Expected "${normalizedValue}", found "${finalValue}".`);
  }
}

async function fillHipaaPatientDob(scope, value) {
  const oldDobField = scope.locator(HIPAA_SELECTORS.patientDob).first();
  if (await oldDobField.isVisible({ timeout: 1500 }).catch(() => false)) {
    await fillTextField(scope, HIPAA_SELECTORS.patientDob, value);
    return;
  }

  await fillMuiDateByLabel(scope, "Patient Date of Birth", value);
}

async function fillAndVerifyDateField(scope, selector, value, fieldName) {
  const expectedValue = String(value || "").trim();
  const field = scope.locator(selector).first();
  if (!await field.isVisible({ timeout: 1500 }).catch(() => false)) {
    await fillMuiDateByLabel(scope, fieldName === "Service From" ? "Service From Date" : "Service To Date", expectedValue);
    return;
  }

  await field.waitFor({ state: "visible", timeout: 15000 });

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await field.click({ force: true });
    await field.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await field.press("Backspace");
    await field.fill(expectedValue);
    await field.press("Tab");
    await humanDelay(250, 500);

    const actualValue = await field.inputValue().catch(() => "");
    if (actualValue.trim() === expectedValue) {
      return;
    }

    logger.warn(`HIPAA ${fieldName} date value mismatch after fill attempt ${attempt}: expected="${expectedValue}", actual="${actualValue}". Retrying.`);
  }

  const finalValue = await field.inputValue().catch(() => "");
  if (finalValue.trim() !== expectedValue) {
    throw new Error(`HIPAA ${fieldName} date was not set correctly. Expected "${expectedValue}", found "${finalValue}".`);
  }
}

async function ensureChecked(scope, selector) {
  const checkbox = scope.locator(selector).first();
  if (!await checkbox.isVisible({ timeout: 1500 }).catch(() => false)) {
    logger.info("HIPAA subscriber-same-as-patient checkbox not visible; continuing because this form variant does not require it.");
    return;
  }

  if (!await checkbox.isChecked().catch(() => false)) {
    await checkbox.check({ force: true });
  }
}

async function fillHipaaSearchForm(page, rowData) {
  const frame = await getClaimStatusFrame(page);
  const name = splitPatientName(rowData["Patient Name"]);

  await fillTextField(frame, HIPAA_SELECTORS.memberId, rowData["Subscriber No"]);
  await fillTextField(frame, HIPAA_SELECTORS.patientFirstName, name.firstName);
  await fillTextField(frame, HIPAA_SELECTORS.patientLastName, name.lastName);
  await fillHipaaPatientDob(frame, rowData["Patient DOB"]);
  await ensureChecked(frame, HIPAA_SELECTORS.patientIsSubscriber);
  await fillAndVerifyDateField(frame, HIPAA_SELECTORS.serviceFromDate, rowData["Service Date"], "Service From");
  await fillAndVerifyDateField(frame, HIPAA_SELECTORS.serviceToDate, rowData["Service Date"], "Service To");
}

async function resultIndicatorAppeared(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame = await getClaimStatusFrame(page);
    const headingVisible = await frame.locator(HIPAA_SELECTORS.resultsHeading).first().isVisible({ timeout: 500 }).catch(() => false);
    const noResultsVisible = await frame.locator(HIPAA_SELECTORS.noResultsMessage).first().isVisible({ timeout: 500 }).catch(() => false);
    const portalAlertVisible = await frame.locator(HIPAA_SELECTORS.portalAlert).first().isVisible({ timeout: 500 }).catch(() => false);

    if (headingVisible || noResultsVisible || portalAlertVisible) {
      return true;
    }

    await humanDelay(800, 1200);
  }

  return false;
}

async function submitHipaaSearch(page) {
  await withRetry(
    "Submitting HIPAA Standard search",
    async () => {
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const frame = await getClaimStatusFrame(page);
        const submitButton = frame.locator(HIPAA_SELECTORS.submitButton).first();
        await submitButton.waitFor({ state: "visible", timeout: 15000 });
        await submitButton.scrollIntoViewIfNeeded().catch(() => {});
        await submitButton.click({ force: attempt > 1 });
        logger.info(`HIPAA Standard Submit clicked (attempt ${attempt}/3). Waiting for portal response.`);
        await humanDelay(1500, 2500);

        if (await resultIndicatorAppeared(page, 5000)) {
          logger.info(`HIPAA Standard search response appeared after submit attempt ${attempt}.`);
          return;
        }

        if (attempt < 3) {
          logger.warn(`HIPAA Standard results did not appear within 5 seconds after submit attempt ${attempt}. Re-clicking Submit.`);
        }
      }

      throw new Error("HIPAA Standard submit did not produce results, no-results message, or validation response after 3 attempts.");
    },
    { retries: 1, retryDelayMs: 1200 }
  );
}

async function searchHipaaWithProvider(page, providerName, rowData) {
  logger.info(`HIPAA Standard search provider attempt: ${providerName}`);
  await selectHipaaTab(page);
  await selectProvider(page, providerName);
  await fillHipaaSearchForm(page, rowData);
  await submitHipaaSearch(page);
}

module.exports = {
  HIPAA_SELECTORS,
  fillHipaaSearchForm,
  isHipaaTabAvailable,
  isMemberTabAvailable,
  selectHipaaTab,
  selectProvider,
  searchHipaaWithProvider,
  splitPatientName,
  waitForSearchTabs
};
