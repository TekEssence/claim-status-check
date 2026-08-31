"use strict";

const logger = require("../../utils/logger");
const { waitForSearchTabs } = require("../../pages/claim-status-hipaa.page");
const { PROVIDERS } = require("../../pages/claim-status-member.page");
const { runHipaaProviderSearch } = require("../../workflows/shared-claim-workflow");
const serviceDatesWorkflow = require("./tabs/service-date/workflow");

async function processClaim(page, row, options = {}) {
  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : PROVIDERS;
  const { hipaaAvailable } = await waitForSearchTabs(page, 5000, { preferHipaa: true });

  if (hipaaAvailable) {
    logger.info("Using Anthem-CA workflow: HIPAA Standard tab first.");
    return runHipaaProviderSearch(page, row, providerOrder, {
      matchingPolicy: options.matchingPolicy
    });
  }

  logger.info("Anthem-CA HIPAA Standard tab is unavailable; falling back to Service Dates.");
  return serviceDatesWorkflow.processClaim(page, row, {
    ...options,
    providerOrder
  });
}

module.exports = {
  name: "anthem-ca",
  processClaim
};
