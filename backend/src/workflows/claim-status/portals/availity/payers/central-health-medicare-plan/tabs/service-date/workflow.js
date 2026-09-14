"use strict";

const { createServiceDateDetailExtractor, createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractWellcareDenied: extractCentralHealthMedicarePlanDenied,
  extractWellcarePaid: extractCentralHealthMedicarePlanPaid
} = require("../../../../pages/claim-detail.page");

module.exports = createServiceDateWorkflow({
  name: "central-health-medicare-plan",
  payerLabel: "Central Health Medicare Plan",
  extractMatchedRow: createServiceDateDetailExtractor({ payerLabel: "Central Health Medicare Plan", extractPaid: extractCentralHealthMedicarePlanPaid, extractDenied: extractCentralHealthMedicarePlanDenied }),
});
