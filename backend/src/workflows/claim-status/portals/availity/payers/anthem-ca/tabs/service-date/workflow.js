"use strict";

const { createServiceDateDetailExtractor, createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractWellcareDenied: extractAnthemCaDenied,
  extractWellcarePaid: extractAnthemCaPaid
} = require("../../../../pages/claim-detail.page");

module.exports = createServiceDateWorkflow({
  name: "anthem-ca",
  payerLabel: "Anthem-CA",
  fillNonCharmInputProviderIdentifiers: true,
  providerSelectionOptions: {
    allowInputIdentifiersWhenProviderUnavailable: true,
    requireExactTaxIdOption: false,
  },
  extractMatchedRow: createServiceDateDetailExtractor({ payerLabel: "Anthem-CA", extractPaid: extractAnthemCaPaid, extractDenied: extractAnthemCaDenied }),
});


