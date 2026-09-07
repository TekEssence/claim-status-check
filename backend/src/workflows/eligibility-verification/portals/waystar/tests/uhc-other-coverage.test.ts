import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import * as XLSX from "xlsx";
import { extractMedRevenueUhcOtherCoverage } from "../payers/united-healthcare-all-states/medrevenue-other-coverage";
import { getWaystarPayer } from "../payer-registry";
import { getWaystarProjectConfig, getWaystarPayerProjectConfig } from "../config/projects";
import { buildWaystarOutputWorkbook } from "../output";
import { installBrowserEvalHelpers } from "@/backend/src/core/playwright-browser-eval-helpers";

const blocks = [{ payer: "MURCURY INSURANCE", cobDate: "12/18/2014 to 12/31/9999", serviceType: "Pharmacy" }];
const row = { originalIndex: 2, raw: {}, dateOfService: "09/02/2026" };
const payload = { overallStatus: "Active Coverage", subscriberCoverageInformation: { planDate: "09/02/2026" }, fullPayerResponse: { uhcOtherCoveragePayerBlocks: blocks } };

test("MedRevenue UHC outputs full COB range and service from the same payer block", async () => {
  const result = getWaystarPayer("united-healthcare-all-states", "medrevenue").parseResult(payload, row);
  assert.equal(result.planDate, blocks[0].cobDate);
  assert.equal(result.metadata?.medRevenueOutputServiceType, "Pharmacy");
  assert.equal(row.dateOfService, "09/02/2026");
  const input = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(input, XLSX.utils.aoa_to_sheet([["DOS"], [row.dateOfService]]), "Input");
  const inputFile = new File([XLSX.write(input, { type: "buffer", bookType: "xlsx" })], "test.xlsx");
  const output = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: "medrevenue" });
  const book = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets[book.SheetNames[0]]);
  assert.equal(rows[0]["Plan Date"], blocks[0].cobDate);
  assert.equal(rows[0]["Service Type"], "Pharmacy");
});

test("vendor Service Type reaches Excel even without a payer or COB Date", async () => {
  const result = getWaystarPayer("united-healthcare-all-states", "medrevenue").parseResult({ ...payload, fullPayerResponse: { uhcOtherCoveragePayerBlocks: [
    { payer: "", cobDate: "", serviceType: "Pharmacy" },
    { payer: "", cobDate: "", serviceType: "Pharmacy" },
  ] } }, row);
  assert.equal(result.planDate, undefined);
  assert.equal(result.metadata?.medRevenueOutputServiceType, "Pharmacy");
  const input = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(input, XLSX.utils.aoa_to_sheet([["DOS"], [row.dateOfService]]), "Input");
  const inputFile = new File([XLSX.write(input, { type: "buffer", bookType: "xlsx" })], "test.xlsx");
  const output = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: "medrevenue" });
  const book = XLSX.read(output, { type: "buffer" });
  const rows = XLSX.utils.sheet_to_json<Record<string, string>>(book.Sheets[book.SheetNames[0]]);
  assert.equal(rows[0]["Plan Date"], "-");
  assert.equal(rows[0]["Service Type"], "Pharmacy");
  assert.equal(rows[0]["DOS"], row.dateOfService);
});

test("the UHC COB mapping does not apply to other project/payer parsers", () => {
  for (const project of ["medrevenue", "minimax"] as const) {
    for (const payer of ["medicare", "bcbs-ppo", "united-healthcare-all-states"]) {
      const config = getWaystarPayerProjectConfig(getWaystarProjectConfig(project), payer);
      assert.equal(Boolean(config.extractUhcOtherCoverage), project === "medrevenue" && payer === "united-healthcare-all-states");
      if (project === "medrevenue" && payer === "united-healthcare-all-states") continue;
      assert.notEqual(getWaystarPayer(payer, project).parseResult(payload, row).planDate, blocks[0].cobDate);
    }
  }
});

test("missing COB block leaves output Plan Date empty instead of using inquiry DOS", () => {
  const result = getWaystarPayer("united-healthcare-all-states", "medrevenue").parseResult({ ...payload, fullPayerResponse: { uhcOtherCoveragePayerBlocks: [] } }, row);
  assert.equal(result.planDate, undefined);
});

test("browser reads payer COB and sibling Service Type without mixing vendor information", { skip: process.env.WAYSTAR_BROWSER_TESTS !== "true" }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await installBrowserEvalHelpers(page);
    await page.setContent(`<div class="ContentContainer"><h4>Other Coverage Information</h4>
      <div class="HalfColumn"><div class="Row"><div class="Label">Health Insurance Claim (HIC) Number</div><div class="Text">TEST-HIC</div></div></div>
      <div class="HalfColumn"><div class="Row"><div class="Label">Vendor</div><div class="Text">OPTUMRX</div></div><div class="Label">Service Type</div><div class="Text List"><span class="ListItem">Vendor-only service</span><br></div></div>
      <div class="HalfColumn"><div class="Row"><div class="Label">Payer</div><div class="Text">MURCURY INSURANCE</div></div><div class="Row"><div class="Label">COB Date</div><div class="Text">12/18/2014 to 12/31/9999</div></div><div class="Label">Service Type</div><div class="Text List"><span class="ListItem">Pharmacy</span><br></div></div>
    </div>`);
    const extracted = await page.evaluate(extractMedRevenueUhcOtherCoverage);
    assert.deepEqual(extracted, [{ payer: "", cobDate: "", serviceType: "Vendor-only service" }, ...blocks]);
    const result = getWaystarPayer("united-healthcare-all-states", "medrevenue").parseResult({ ...payload, fullPayerResponse: { uhcOtherCoveragePayerBlocks: extracted } }, row);
    assert.equal(result.metadata?.medRevenueOutputServiceType, "Pharmacy");
    await page.locator(".HalfColumn").last().evaluate((element) => element.remove());
    const vendorOnly = await page.evaluate(extractMedRevenueUhcOtherCoverage);
    assert.deepEqual(vendorOnly, [{ payer: "", cobDate: "", serviceType: "Vendor-only service" }]);
  } finally { await browser.close(); }
});
