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

async function fillInputProviderIdentifiers(page, rowData) {
  const { npi, taxId } = getInputProviderIdentifiers(rowData);
  const frame = await getClaimStatusFrame(page);

  if (npi) {
    if (!/^[1-4]\d{9}$/.test(npi)) {
      throw new Error(`Provider NPI must contain 10 digits and begin with 1, 2, 3, or 4. Received "${npi}".`);
    }
    await typeAndVerify(frame.locator("input#providerNpi[name='providerNpi'], input#providerNpi").first(), npi, "Provider NPI");
  }

  if (taxId) {
    if (!/^\d{9}$/.test(taxId)) {
      throw new Error(`Provider Tax ID must contain exactly 9 digits. Received "${taxId}".`);
    }
    await typeAndVerify(frame.locator("input#providerTaxId[name='providerTaxId'], input#providerTaxId").first(), taxId, "Provider Tax ID");
  }
}

module.exports = {
  fillInputProviderIdentifiers,
  getInputProviderIdentifiers,
  hasInputProviderIdentifiers
};
