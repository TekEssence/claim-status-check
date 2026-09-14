"use strict";

const { createServiceDateDetailExtractor, createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractWellcareDenied: extractMolinaDenied,
  extractWellcarePaid: extractMolinaPaid
} = require("../../../../pages/claim-detail.page");

module.exports = createServiceDateWorkflow({
  name: "molina",
  payerLabel: "Molina",
  requestedStatusValue: "ALL",
  extractMatchedRow: createServiceDateDetailExtractor({ payerLabel: "Molina", extractPaid: extractMolinaPaid, extractDenied: extractMolinaDenied }),
});



