"use strict";

const { createServiceDateDetailExtractor, createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractWellcareDenied: extractHumanaDenied,
  extractWellcarePaid: extractHumanaPaid,
} = require("../../../../pages/claim-detail.page");

module.exports = createServiceDateWorkflow({
  name: "humana",
  payerLabel: "Humana",
  extractMatchedRow: createServiceDateDetailExtractor({ payerLabel: "Humana", extractPaid: extractHumanaPaid, extractDenied: extractHumanaDenied }),
});
