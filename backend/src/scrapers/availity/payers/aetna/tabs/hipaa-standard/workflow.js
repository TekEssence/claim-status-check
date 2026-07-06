"use strict";

const logger = require("../../../../legacy/utils/logger");
const { waitForSearchTabs } = require("../../../../legacy/pages/claim-status-hipaa.page");
const { renderFailedSummary } = require("../../../../legacy/services/summary-renderer");
const { runHipaaProviderSearch } = require("../../../../legacy/workflows/shared-claim-workflow");

const AETNA_PROVIDER_ORDER = ["DAO, THUAN DUC", "TRINITY PAIN MANAGEMENT"];

async function processClaim(page, row) {
  logger.info("Using Aetna workflow: HIPAA Standard search only.");
  const { hipaaAvailable } = await waitForSearchTabs(page, 3000, { preferHipaa: true });
  logger.info(`Aetna workflow tabs detected: hipaa_standard=${hipaaAvailable}`);

  if (!hipaaAvailable) {
    return {
      status: "failed",
      summaries: [renderFailedSummary("HIPAA Standard tab is not available for Aetna payer workflow.")],
      matchCount: 0,
      provider: "",
      sourceTab: "",
      notes: "Aetna workflow requires HIPAA Standard tab, but it was not visible."
    };
  }

  return runHipaaProviderSearch(page, row, AETNA_PROVIDER_ORDER);
}

module.exports = {
  name: "aetna",
  processClaim
};
