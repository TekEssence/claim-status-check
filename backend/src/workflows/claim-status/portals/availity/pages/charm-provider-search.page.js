"use strict";

const { clearProviderFormIfVisible, fillInputProviderIdentifiers } = require("./provider-identifiers.page");
const { throwIfVisibleFieldValidation } = require("./results.page");

async function fillSearchFieldsAndSubmit(page, rowData, options = {}) {
  await options.fillSearchForm(page, rowData);
  await throwIfVisibleFieldValidation(page, options.context || "Charm Availity");
  await options.submitSearch(page);
}

function assertCharmSearchOptions(options = {}) {
  if (typeof options.fillSearchForm !== "function") {
    throw new Error("Charm Availity shared search requires fillSearchForm.");
  }
  if (typeof options.submitSearch !== "function") {
    throw new Error("Charm Availity shared search requires submitSearch.");
  }
}

async function trySubmitCharmSearchWithoutProviderDropdown(page, rowData, options = {}) {
  if (options.projectId !== "charm") return false;
  assertCharmSearchOptions(options);

  const context = options.context || "Charm Availity";
  await clearProviderFormIfVisible(page, { context, logger: options.logger });

  const providerFill = await fillInputProviderIdentifiers(page, rowData, {
    charmRequiredOnly: true,
    logger: options.logger,
    providerMode: options.providerMode,
  });

  if (providerFill?.providerIdentifierReady) {
    await fillSearchFieldsAndSubmit(page, rowData, { ...options, context });
    return true;
  }

  if (!providerFill?.requiresProviderDropdown) {
    throw new Error(`${context} provider identifiers could not be filled deterministically.`);
  }

  return false;
}

async function submitCharmSearchAfterProviderDropdown(page, rowData, options = {}) {
  if (options.projectId !== "charm") return false;
  assertCharmSearchOptions(options);

  const context = options.context || "Charm Availity";
  const providerFill = await fillInputProviderIdentifiers(page, rowData, {
    charmRequiredOnly: true,
    logger: options.logger,
    providerMode: options.providerMode,
    providerDropdownSelected: Boolean(options.providerDropdownSelected),
    providerDropdownText: options.providerDropdownText,
  });

  if (providerFill?.requiresProviderDropdown) {
    throw new Error(`${context} provider dropdown was selected, but required provider fields were still not auto-filled.`);
  }

  if (!providerFill?.providerIdentifierReady) {
    throw new Error(`${context} provider identifiers were still incomplete after provider selection.`);
  }

  await fillSearchFieldsAndSubmit(page, rowData, { ...options, context });
  return true;
}

module.exports = {
  submitCharmSearchAfterProviderDropdown,
  trySubmitCharmSearchWithoutProviderDropdown,
};
