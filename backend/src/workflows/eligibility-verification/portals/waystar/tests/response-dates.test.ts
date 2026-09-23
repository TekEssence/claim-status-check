import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright-core";
import * as XLSX from "xlsx";
import { extractWaystarResponseDates } from "../payers/response-dates";
import { getWaystarPayer } from "../payer-registry";
import { buildWaystarOutputWorkbook } from "../output";
import { installBrowserEvalHelpers } from "@/backend/src/core/playwright-browser-eval-helpers";

test("response dates reach Excel without HBPC or Row.clearfix wrappers", { skip: process.env.WAYSTAR_BROWSER_TESTS !== "1" }, async () => {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    const page = await browser.newPage();
    await installBrowserEvalHelpers(page);
    await page.setContent(`<h3>Payer Response</h3><div class="ContentContainer"><div class="HalfColumn"><h4>Subscriber Information</h4></div><div class="HalfColumn"><div class="Label">Plan Begin Date</div><div class="Text">02/15/2025</div>
      <h4>Subscriber Coverage Information</h4>
      <div class="Row clearfix"><div class="Label">Eligibility Begin Date</div><div class="Text">01/01/2025</div></div>
      <div class="Row clearfix"><div class="Label">Benefit Begin Date</div><div class="Text">01/01/2025</div></div></div></div>
      <div class="ContentContainer"><h4>OTHER COVERAGE INFORMATION</h4><div class="HalfColumn"><div class="Label">Vendor</div><div class="Text">NAVITUS</div>
      <div class="Row clearfix"><div class="Label">Eligibility Begin Date</div><div class="Text">04/01/2025</div></div>
      <div class="OtherCoverage">Other Coverage</div><div class="Row clearfix"><div class="Label">Benefit Begin Date</div><div class="Text">01/01/2026</div></div></div></div>`);
    const exactResponseDates = await page.evaluate(extractWaystarResponseDates);
    for (const [payer, expected] of [["umr", "01/01/2026"], ["aetna", "01/01/2025"]]) {
      const row = { originalIndex: 2, raw: {}, dateOfService: "09/07/2026" };
      const result = getWaystarPayer(payer, "medrevenue").parseResult({ overallStatus: "Active Coverage", exactResponseDates }, row);
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Payer: payer }]), "Input");
      const inputFile = new File([new Uint8Array(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }))], "input.xlsx");
      const output = await buildWaystarOutputWorkbook({ inputFile, rows: new Map([[2, row]]), results: new Map([[2, result]]), errors: new Map(), projectId: "medrevenue" });
      const parsed = XLSX.read(output, { type: "buffer" });
      const values = XLSX.utils.sheet_to_json<Record<string, unknown>>(parsed.Sheets.Output)[0];
      assert.equal(values["Eff Date"], expected);
      assert.equal(values["Plan Date"], "02/15/2025");
    }
    await page.setContent('<div class="Label">Plan Date</div><div class="Text">09/07/2026</div>');
    const missing = await page.evaluate(extractWaystarResponseDates);
    assert.equal(missing.eligibilityBeginDate, undefined);
    assert.equal(missing.benefitBeginDate, undefined);
    await page.setContent(`<h4>Other Coverage Information</h4><table><tr><td>Eligibility Begin Date</td><td>04/01/2025</td></tr></table>
      <div>Benefit Begin Date</div><div>01/01/2026</div><div>Plan Begin Date</div><div>02/15/2025</div>`);
    assert.deepEqual(await page.evaluate(extractWaystarResponseDates), {
      eligibilityBeginDate: undefined, benefitBeginDate: '01/01/2026', planBeginDate: '02/15/2025',
    });
    await page.setContent('<div>Benefit Begin Date</div><div>Plan Begin Date</div><div>02/15/2025</div>');
    assert.equal((await page.evaluate(extractWaystarResponseDates)).benefitBeginDate, undefined);
    await page.setContent(`<h4>Subscriber Coverage Information</h4><table><tr><td><strong>Eligibility Begin Date</strong></td><td><span>04/01/2025</span></td></tr></table>
      <h4>Other Coverage Information</h4><div><div><span>Benefit Begin Date</span></div><div><span>01/01/2026</span></div></div>`);
    const nested = await page.evaluate(extractWaystarResponseDates);
    assert.equal(nested.eligibilityBeginDate, '04/01/2025');
    assert.equal(nested.benefitBeginDate, '01/01/2026');
    await page.setContent(`<div class="ContentContainer"><div class="HalfColumn">
      <h4>Other Coverage Information</h4><div class="Row clearfix"><div class="Label">Vendor</div><div class="Text">Example</div></div>
      </div><div class="HalfColumn"><h4>Subscriber Coverage Information</h4>
      <div class="Row clearfix"><div class="Label">Eligibility Begin Date</div><div class="Text">01/01/2025</div></div>
      <div class="Row clearfix"><div class="Label">Benefit Begin Date</div><div class="Text">01/01/2025</div></div></div></div>`);
    const missingOtherDates = await page.evaluate(extractWaystarResponseDates);
    for (const payer of ["aetna", "umr"]) {
      const result = getWaystarPayer(payer, "medrevenue").parseResult({
        exactResponseDates: missingOtherDates,
        healthBenefitPlanCoverage: { eligibilityBeginDate: "01/01/2025", benefitBeginDate: "01/01/2025" },
      }, { originalIndex: 2, raw: {} });
      assert.equal(result.effectiveDate, payer === "aetna" ? "01/01/2025" : undefined);
    }
  } finally { await browser.close(); }
});
