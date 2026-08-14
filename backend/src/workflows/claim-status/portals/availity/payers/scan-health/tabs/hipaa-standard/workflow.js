"use strict";

const logger = require("../../../../legacy/utils/logger");
const { waitForSearchTabs } = require("../../../../legacy/pages/claim-status-hipaa.page");
const { renderFailedSummary } = require("../../../../legacy/services/summary-renderer");
const { runHipaaProviderSearch } = require("../../../../legacy/workflows/shared-claim-workflow");

const SCAN_HEALTH_PROVIDER_ORDER = ["DAO, THUAN DUC", "TRINITY PAIN MANAGEMENT"];

async function processClaim(page, row, options = {}) {
  logger.info("Using Scan Health workflow: HIPAA Standard search only.");
  const { hipaaAvailable } = await waitForSearchTabs(page, 3000, { preferHipaa: true });
  logger.info(`Scan Health workflow tabs detected: hipaa_standard=${hipaaAvailable}`);

  if (!hipaaAvailable) {
    return {
      status: "failed",
      summaries: [renderFailedSummary("HIPAA Standard tab is not available for Scan Health payer workflow.")],
      matchCount: 0,
      provider: "",
      sourceTab: "",
      notes: "Scan Health workflow requires HIPAA Standard tab, but it was not visible."
    };
  }

  const providerOrder = Array.isArray(options.providerOrder) && options.providerOrder.length
    ? options.providerOrder
    : SCAN_HEALTH_PROVIDER_ORDER;
  return runHipaaProviderSearch(page, row, providerOrder);
}

module.exports = {
  name: "scan-health",
  processClaim
};
