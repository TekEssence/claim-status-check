"use strict";

const logger = require("../../../../legacy/utils/logger");
const { waitForSearchTabs } = require("../../../../legacy/pages/claim-status-hipaa.page");
const { PROVIDERS } = require("../../../../legacy/pages/claim-status-member.page");
const { renderFailedSummary } = require("../../../../legacy/services/summary-renderer");
const { runHipaaProviderSearch } = require("../../../../legacy/workflows/shared-claim-workflow");

async function processClaim(page, row) {
  logger.info("Using Wellpoint workflow: HIPAA Standard search only.");
  const { hipaaAvailable } = await waitForSearchTabs(page, 3000, { preferHipaa: true });
  logger.info(`Wellpoint workflow tabs detected: hipaa_standard=${hipaaAvailable}`);

  if (!hipaaAvailable) {
    return {
      status: "failed",
      summaries: [renderFailedSummary("HIPAA Standard tab is not available for Wellpoint payer workflow.")],
      matchCount: 0,
      provider: "",
      sourceTab: "",
      notes: "Wellpoint workflow requires HIPAA Standard tab, but it was not visible."
    };
  }

  return runHipaaProviderSearch(page, row, PROVIDERS, {
    useHipaaDeniedExtractorForDeniedStatus: true,
    hipaaExtractionOptions: {
      preferExpandedReasonRemarkCode: true
    }
  });
}

module.exports = {
  name: "wellpoint",
  processClaim
};
