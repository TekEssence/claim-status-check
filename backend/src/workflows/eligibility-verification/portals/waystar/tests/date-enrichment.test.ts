import assert from "node:assert/strict";
import test from "node:test";
import { getWaystarPayer } from "../payer-registry";

test("empty optional date reads preserve successful results and previously captured dates", () => {
  const payload = {
    overallStatus: "Active Coverage",
    healthBenefitPlanCoverage: { eligibilityBeginDate: "04/01/2025", benefitBeginDate: "01/01/2026", eligibilityEndDate: "12/31/2026" },
    subscriberCoverageInformation: { planBeginDate: "02/15/2025", planNetworkName: "PPO" },
  };
  for (const payer of ["umr", "aetna"]) {
    const handler = getWaystarPayer(payer, "medrevenue");
    const row = { originalIndex: 2, raw: {} };
    const baseline = handler.parseResult(payload, row);
    assert.deepEqual(handler.parseResult({ ...payload, exactResponseDates: {} }, row), baseline);
    const enriched = handler.parseResult({ ...payload, exactResponseDates: {
      eligibilityBeginDate: "05/01/2025", benefitBeginDate: "02/01/2026", planBeginDate: "01/01/2000",
    } }, row);
    assert.deepEqual({ ...enriched, effectiveDate: baseline.effectiveDate }, baseline);
    assert.equal(enriched.effectiveDate, payer === "umr" ? "02/01/2026" : "05/01/2025");
    assert.equal(enriched.coverageStatus, "active");
  }
});
