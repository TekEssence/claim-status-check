"use strict";

const logger = require("../../../../utils/logger");
const { createServiceDateWorkflow } = require("../../../../workflows/service-date-workflow");
const {
  extractInProcess,
  extractWellcareDenied: extractHealthNetDenied,
  extractWellcarePaid: extractHealthNetPaid,
  waitForClaimDetailPage,
} = require("../../../../pages/claim-detail.page");

async function extractHealthNetMatchedRow(page, matchedRow) {
  logger.info(
    `Preparing to extract Health Net matched row: claim="${matchedRow.claimNumber}", status="${matchedRow.status.display}", service_date="${matchedRow.serviceDate}", billed="${matchedRow.billedAmount}", member_id="${matchedRow.memberId}"`
  );

  if (matchedRow.status.type === "unsupported") {
    return {
      type: "unsupported",
      claimNumber: matchedRow.claimNumber,
      claimStatus: matchedRow.status.display,
    };
  }

  await matchedRow.row.click();
  logger.info(`Clicked Health Net matched result row for claim ${matchedRow.claimNumber}. Waiting for detail page.`);
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  await waitForClaimDetailPage(page);
  logger.success(`Health Net detail page loaded for claim ${matchedRow.claimNumber}`);

  if (matchedRow.status.type === "in_process") {
    const extracted = await extractInProcess(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  if (matchedRow.status.type === "paid") {
    const extracted = await extractHealthNetPaid(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  if (matchedRow.status.type === "denied") {
    const extracted = await extractHealthNetDenied(page, matchedRow.status.display);
    extracted.claimNumber = extracted.claimNumber || matchedRow.claimNumber;
    return extracted;
  }

  return {
    type: "unsupported",
    claimNumber: matchedRow.claimNumber,
    claimStatus: matchedRow.status.display,
  };
}

module.exports = createServiceDateWorkflow({
  name: "health-net",
  payerLabel: "Health Net",
  extractMatchedRow: extractHealthNetMatchedRow,
});
