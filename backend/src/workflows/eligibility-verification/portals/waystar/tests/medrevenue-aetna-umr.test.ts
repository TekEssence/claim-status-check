import assert from "node:assert/strict";
import test from "node:test";
import { routeWaystarRowsByPayer } from "../input";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";
import { getWaystarPayer } from "../payer-registry";
import { payerSearchTerms, isExactWaystarPayerMatch } from "../portal";

test("MedRevenue Aetna and UMR names select their own payer even with X or 9 IDs", () => {
  for (const [name, id, portal] of [["Aetna", "aetna", "Aetna (60054)"], ["UMR", "umr", "UMR (39026)"]]) {
    for (const member of ["XTEST123", "912345", "ATEST123"]) {
      const project = getWaystarProjectConfig("medrevenue");
      const routing = routeWaystarRowsByPayer([{ "Primary Insurance Name": name, "Member ID": member }], { projectConfig: project });
      assert.deepEqual(routing.unsupportedRows, []);
      assert.equal(routing.batches[0].payerId, id);
      const config = getWaystarPayerProjectConfig(project, id);
      assert.equal(config.portalPayerName, portal);
      assert.deepEqual(payerSearchTerms(portal, config), [name]);
      assert.equal(config.requireExactPayerSuggestionCommit, true);
      assert.equal(config.settings?.extractOtherCoverageServiceTypes, true);
      assert.equal(isExactWaystarPayerMatch(`${name} (99999)`, portal), false);
      const result = getWaystarPayer(id, "medrevenue").parseResult({ overallStatus: "Active Coverage" }, { originalIndex: 2, raw: {} });
      assert.equal(result.payerId, id);
    }
  }
  assert.equal(getWaystarPayer("aetna", "medrevenue").credentialProject, undefined);
  assert.equal(getWaystarPayer("aetna", "minimax").credentialProject, "FL2");
});
