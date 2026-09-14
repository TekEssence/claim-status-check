"use strict";

const { createServiceDateDetailExtractor, createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractWellcareDenied,
  extractWellcarePaid,
} = require("../../../../pages/claim-detail.page");

module.exports = createServiceDateWorkflow({
  name: "wellcare",
  payerLabel: "Wellcare",
  extractMatchedRow: createServiceDateDetailExtractor({ payerLabel: "Wellcare", extractPaid: extractWellcarePaid, extractDenied: extractWellcareDenied }),
});
