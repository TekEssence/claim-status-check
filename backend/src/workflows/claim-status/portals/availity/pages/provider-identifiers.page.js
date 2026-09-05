"use strict";

const { getClaimStatusFrame } = require("./navigation.page");

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function getInputProviderIdentifiers(rowData) {
  return {
    npi: digitsOnly(rowData?.["Provider NPI"]),
    taxId: digitsOnly(rowData?.["Provider Tax ID"] || rowData?.["Tax ID"])
  };
}

function hasInputProviderIdentifiers(rowData) {
  const { npi, taxId } = getInputProviderIdentifiers(rowData);
  return Boolean(npi || taxId);
}

async function getProviderNpiValue(frame) {
  const providerNpiInput = frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi, input[name='providerNpi']").first();
  return providerNpiInput.inputValue({ timeout: 1000 }).then((value) => digitsOnly(value)).catch(() => "");
}

async function clearProviderNpiField(frame, options = {}) {
  const providerNpiInput = frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi, input[name='providerNpi']").first();
  if (!await providerNpiInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    return;
  }

  await providerNpiInput.click({ force: true }).catch(() => {});
  await providerNpiInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await providerNpiInput.press("Backspace").catch(() => {});
  await providerNpiInput.evaluate((input) => {
    if (!input || !("value" in input)) return;
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }).catch(() => {});

  const remainingNpi = await getProviderNpiValue(frame);
  if (remainingNpi) {
    options.logger?.warn?.(`${options.context || "Availity"} Provider NPI stayed populated after clear: "${remainingNpi}".`);
  }
}

async function clearProviderStateForTaxIdFallback(page, options = {}) {
  const frame = await getClaimStatusFrame(page);
  const context = options.context || "Availity Tax ID fallback";
  const clearButton = frame.locator("button:has-text('Clear Form'), input[type='button'][value='Clear Form']").first();

  if (await clearButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    options.logger?.info?.(`${context}: clicking Clear Form before filling Provider Tax ID.`);
    await clearButton.click({ force: true });

    await new Promise((resolve) => setTimeout(resolve, 1000));
    let remainingNpi = await getProviderNpiValue(frame);
    if (!remainingNpi) {
      return frame;
    }

    options.logger?.warn?.(`${context}: Provider NPI still populated 1 second after Clear Form: "${remainingNpi}". Waiting 1 more second.`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    remainingNpi = await getProviderNpiValue(frame);
    if (!remainingNpi) {
      return frame;
    }

    const clearButtonEnabled = await clearButton.isEnabled({ timeout: 1000 }).catch(() => false);
    if (clearButtonEnabled) {
      options.logger?.warn?.(`${context}: Provider NPI still populated after 2 seconds. Clicking Clear Form again.`);
      await clearButton.click({ force: true });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      remainingNpi = await getProviderNpiValue(frame);
      if (!remainingNpi) {
        return frame;
      }
    }

    options.logger?.warn?.(`${context}: Provider NPI stayed populated after Clear Form: "${remainingNpi}".`);
  } else {
    options.logger?.warn?.(`${context}: Clear Form button was not visible; clearing Provider NPI field directly.`);
  }

  await clearProviderNpiField(frame, options);
  return frame;
}

async function clearProviderFormIfVisible(page, options = {}) {
  const frame = await getClaimStatusFrame(page);
  const context = options.context || "Availity";
  const clearButton = frame.locator("button:has-text('Clear Form'), input[type='button'][value='Clear Form']").first();
  if (!await clearButton.isVisible({ timeout: 1500 }).catch(() => false)) {
    options.logger?.info?.(`${context}: Clear Form button was not visible before provider fill.`);
    return frame;
  }

  options.logger?.info?.(`${context}: clicking Clear Form before filling this claim.`);
  await clearButton.click({ force: true });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return frame;
}

async function verifyProviderNpiMatches(frame, providerName, options = {}) {
  const expectedNpi = digitsOnly(providerName);
  if (!/^\d{10}$/.test(expectedNpi)) {
    return;
  }

  const deadline = Date.now() + (options.timeoutMs || 5000);
  let actualNpi = "";
  while (Date.now() < deadline) {
    actualNpi = await getProviderNpiValue(frame);
    if (actualNpi) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  if (actualNpi !== expectedNpi) {
    throw new Error(`${options.context || "Availity"} selected provider NPI mismatch. Expected "${expectedNpi}", found "${actualNpi || "blank"}".`);
  }
}

function providerPolicySkipsProviderDropdown(providerFieldPolicy = {}) {
  return providerFieldPolicy?.providerDropdown?.fill === false;
}

function getProviderTaxIdForPolicy(rowData, providerFieldPolicy = {}) {
  const valueFrom = providerFieldPolicy?.providerTaxId?.valueFrom;
  const configuredValue = valueFrom ? rowData?.[valueFrom] : "";
  return digitsOnly(configuredValue || rowData?.["Provider Tax ID"] || rowData?.["Tax ID"] || rowData?.["Provider TIN"]);
}

async function typeAndVerify(input, value, label) {
  await input.waitFor({ state: "visible", timeout: 10000 });
  await input.click({ force: true });
  await input.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await input.press("Backspace").catch(() => {});
  await input.pressSequentially(value, { delay: 60 });
  await input.press("Tab").catch(() => {});
  const actual = digitsOnly(await input.inputValue());
  if (actual !== value) {
    throw new Error(`${label} was not filled correctly. Expected "${value}", found "${actual || "blank"}".`);
  }
}

async function isInputReadonly(input) {
  return input.evaluate((element) => Boolean(element.readOnly || element.disabled || element.getAttribute("aria-readonly") === "true"))
    .catch(() => false);
}

async function isProviderFieldRequired(frame, input, labelText) {
  const requiredAttr = await input.evaluate((element) => {
    return Boolean(
      element.required
      || element.getAttribute("aria-required") === "true"
      || element.getAttribute("required") != null
    );
  }).catch(() => false);
  if (requiredAttr) return true;

  const label = frame.locator("label").filter({ hasText: labelText }).first();
  const labelTextValue = await label.innerText({ timeout: 1000 }).catch(() => "");
  return /\*/.test(labelTextValue);
}

async function fillCharmMandatoryProviderIdentifiers(page, rowData, options = {}) {
  const { npi, taxId } = getInputProviderIdentifiers(rowData);
  const frame = await getClaimStatusFrame(page);

  const npiInput = frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi").first();
  if (await npiInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    const npiRequired = await isProviderFieldRequired(frame, npiInput, "Provider NPI");
    const currentNpi = digitsOnly(await npiInput.inputValue({ timeout: 1000 }).catch(() => ""));
    if (npiRequired && !currentNpi) {
      if (!npi) {
        throw new Error("Provider NPI is mandatory on this Availity form, but Provider NPI is blank in the claim file and was not auto-filled.");
      }
      if (await isInputReadonly(npiInput)) {
        throw new Error(`Provider NPI is mandatory on this Availity form, but the field is read-only and was not auto-filled. Claim file Provider NPI="${npi}".`);
      }
      if (!/^[1-4]\d{9}$/.test(npi)) {
        throw new Error(`Provider NPI must contain 10 digits and begin with 1, 2, 3, or 4. Received "${npi}".`);
      }
      options.logger?.info?.(`Charm provider fill: Provider NPI is mandatory and blank. Filling "${npi}".`);
      await typeAndVerify(npiInput, npi, "Provider NPI");
    } else if (npiRequired) {
      options.logger?.info?.(`Charm provider fill: Provider NPI is mandatory and already populated as "${currentNpi}".`);
    }
  }

  const taxIdInput = frame.locator("input#providerTaxId[name='providerTaxId'], input#providerTaxId").first();
  if (await taxIdInput.isVisible({ timeout: 1500 }).catch(() => false)) {
    const taxIdRequired = await isProviderFieldRequired(frame, taxIdInput, "Provider Tax ID");
    const currentTaxId = digitsOnly(await taxIdInput.inputValue({ timeout: 1000 }).catch(() => ""));
    if (taxIdRequired && !currentTaxId) {
      if (!taxId) {
        throw new Error("Provider Tax ID is mandatory on this Availity form, but Provider Tax ID is blank in the claim file.");
      }
      options.logger?.info?.(`Charm provider fill: Provider Tax ID is mandatory and blank. Filling "${taxId}".`);
      await typeAndVerify(taxIdInput, taxId, "Provider Tax ID");
    } else if (taxIdRequired) {
      options.logger?.info?.(`Charm provider fill: Provider Tax ID is mandatory and already populated as "${currentTaxId}".`);
    }
  }
}

async function fillInputProviderIdentifiers(page, rowData, options = {}) {
  if (options.charmRequiredOnly) {
    await fillCharmMandatoryProviderIdentifiers(page, rowData, options);
    return;
  }

  const { npi, taxId } = getInputProviderIdentifiers(rowData);
  const frame = await getClaimStatusFrame(page);

  if (npi) {
    if (!/^[1-4]\d{9}$/.test(npi)) {
      throw new Error(`Provider NPI must contain 10 digits and begin with 1, 2, 3, or 4. Received "${npi}".`);
    }
    await typeAndVerify(frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi").first(), npi, "Provider NPI");
  }

  if (taxId) {
    const taxIdInput = frame.locator("input#providerTaxId[name='providerTaxId'], input#providerTaxId").first();
    if (await taxIdInput.isVisible({ timeout: 1500 }).catch(() => false)) {
      await typeAndVerify(taxIdInput, taxId, "Provider Tax ID");
    }
  }
}

module.exports = {
  clearProviderNpiField,
  clearProviderFormIfVisible,
  clearProviderStateForTaxIdFallback,
  fillInputProviderIdentifiers,
  getProviderTaxIdForPolicy,
  getInputProviderIdentifiers,
  hasInputProviderIdentifiers,
  providerPolicySkipsProviderDropdown,
  verifyProviderNpiMatches
};
