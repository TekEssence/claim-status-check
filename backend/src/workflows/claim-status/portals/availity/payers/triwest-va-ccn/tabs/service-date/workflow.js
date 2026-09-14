"use strict";

const { createServiceDateDetailExtractor, createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractWellcareDenied: extractTriwestVaCcnDenied,
  extractWellcarePaid: extractTriwestVaCcnPaid
} = require("../../../../pages/claim-detail.page");

module.exports = createServiceDateWorkflow({
  name: "triwest-va-ccn",
  payerLabel: "TRIWEST-VA CCN",
  extractMatchedRow: createServiceDateDetailExtractor({ payerLabel: "TRIWEST-VA CCN", extractPaid: extractTriwestVaCcnPaid, extractDenied: extractTriwestVaCcnDenied }),
});
