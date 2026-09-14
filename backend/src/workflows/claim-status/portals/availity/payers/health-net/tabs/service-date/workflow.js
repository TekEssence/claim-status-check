"use strict";

const { createServiceDateDetailExtractor, createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractWellcareDenied: extractHealthNetDenied,
  extractWellcarePaid: extractHealthNetPaid,
} = require("../../../../pages/claim-detail.page");

module.exports = createServiceDateWorkflow({
  name: "health-net",
  payerLabel: "Health Net",
  extractMatchedRow: createServiceDateDetailExtractor({ payerLabel: "Health Net", extractPaid: extractHealthNetPaid, extractDenied: extractHealthNetDenied }),
});
