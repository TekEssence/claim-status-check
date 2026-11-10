import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { claimStatusServicePortalConfigs, prepareGenericClaimStatusServiceInput } from "./generic-claim-status-input";
import { normalizeGenericClaimStatusWorkbook } from "./generic-claim-status-results";
import { servicePortals } from "./portal-dispatch";
import { parseAerialInput } from "../../workflows/claim-status/portals/aerial/input";
import { parseAllCareInput } from "../../workflows/claim-status/portals/all-care/input";
import { parseAstronaInput } from "../../workflows/claim-status/portals/astrona/input";
import { parseBlueShieldInput } from "../../workflows/claim-status/portals/blue-shield/input";
import { parseCignaInput } from "../../workflows/claim-status/portals/cigna/input";
import { parseKaiserInput } from "../../workflows/claim-status/portals/kaiser/input";
import { parseMedpointInput } from "../../workflows/claim-status/portals/medpoint/input";
import { parseMyFamilyInput } from "../../workflows/claim-status/portals/my_family/input";
import { parseOptumProInput } from "../../scrapers/optum-pro/input";
import { parsePhysiciansInput } from "../../workflows/claim-status/portals/physicians/input";
import { parseRegalInput } from "../../workflows/claim-status/portals/regal/input";
import { readClaimsExcel, readLoginExcel } from "../../workflows/claim-status/portals/uhc/excel";
import { parseWaystarInput } from "../../workflows/claim-status/portals/waystar/input";

const account = { login_url: "https://example.test/login", username: "test-user", password: "test-password" };
const fieldValue: Record<string, string> = {
  Group: "PMG", "Responsible Payer": "Aetna", "Member ID": "M1", "Member Name": "DOE,JANE",
  "Subscriber No": "S1", "Patient DOB": "01/01/1990", "Service Date": "01/02/2026",
  "First Name": "Jane", "Last Name": "Doe", CPT: "99213", DOS: "01/02/2026",
  "Member Last Name": "Doe", "Member First Name": "Jane", "Service From Date": "01/02/2026",
  "Medical Group Name": "PMG", Patient: "Jane Doe", "Member Id": "M1", "Patient Name": "Jane Doe",
};

const parseInput: Record<Exclude<keyof typeof claimStatusServicePortalConfigs, "uhc">, (formData: FormData) => Promise<unknown>> = {
  aerial: parseAerialInput, "all-care": parseAllCareInput, astrona: parseAstronaInput,
  "blue-shield": parseBlueShieldInput, cigna: parseCignaInput, kaiser: parseKaiserInput,
  medpoint: parseMedpointInput, "my-family": parseMyFamilyInput, "optum-pro": parseOptumProInput,
  physicians: parsePhysiciansInput, regal: parseRegalInput, waystar: parseWaystarInput,
};

for (const portalId of Object.keys(claimStatusServicePortalConfigs) as Array<keyof typeof claimStatusServicePortalConfigs>) {
  test(`${portalId} service adapter creates worker input files and keeps claim references`, async () => {
    const config = claimStatusServicePortalConfigs[portalId];
    const data = Object.fromEntries([...config.requiredClaims, ...("oneOfClaims" in config ? config.oneOfClaims.flat() : [])]
      .map((field) => [field, fieldValue[field] ?? "test"]));
    const result = await prepareGenericClaimStatusServiceInput(portalId, {
      projectId: portalId === "aerial" ? "pmg" : "minimax",
      claims: [{ client_row_ref: "claim-1", data }],
      credentials: account,
    });
    assert.equal(result.claimCount, 1);
    assert.deepEqual(result.files.map((file) => file.field), [config.claimField, config.loginField]);
    assert.equal(JSON.parse(result.claimRowsJson)[0]["Client Row Ref"], "claim-1");
    const claimBook = new ExcelJS.Workbook();
    await claimBook.xlsx.load(result.files[0].buffer as unknown as Parameters<typeof claimBook.xlsx.load>[0]);
    let claimRefColumn = 0;
    claimBook.worksheets[0].getRow(1).eachCell((cell, column) => {
      if (cell.value === "Client Row Ref") claimRefColumn = column;
    });
    assert.equal(claimBook.worksheets[0].getRow(2).getCell(claimRefColumn).value, "claim-1");
    assert.ok(servicePortals[portalId]);
    if (portalId === "uhc") {
      assert.equal((await readClaimsExcel(result.files[0].buffer.buffer.slice(result.files[0].buffer.byteOffset, result.files[0].buffer.byteOffset + result.files[0].buffer.byteLength) as ArrayBuffer)).length, 1);
      assert.equal((await readLoginExcel(result.files[1].buffer.buffer.slice(result.files[1].buffer.byteOffset, result.files[1].buffer.byteOffset + result.files[1].buffer.byteLength) as ArrayBuffer)).username, "test-user");
    } else {
      const formData = new FormData();
      for (const file of result.files) formData.set(file.field, new File([new Uint8Array(file.buffer)], file.filename));
      for (const [key, value] of Object.entries(result.formFields)) formData.set(key, value);
      await parseInput[portalId](formData);
    }
  });
}

test("group and payer credential accounts must match each claim", async () => {
  const claims = [{ client_row_ref: "one", data: { Group: "PMG", "Responsible Payer": "Aetna", "Member ID": "M1" } }];
  await assert.rejects(() => prepareGenericClaimStatusServiceInput("all-care", {
    claims, credentials: { accounts: [{ ...account, group: "OTHER", payer: "Aetna" }] },
  }), /no matching all-care credential account/);
  const prepared = await prepareGenericClaimStatusServiceInput("all-care", {
    claims, credentials: { accounts: [{ ...account, group: "PMG", payer: "Aetna" }] },
  });
  assert.equal(prepared.claimCount, 1);
});

test("Blue Shield accepts its existing IUMG login for AHK claims", async () => {
  const prepared = await prepareGenericClaimStatusServiceInput("blue-shield", {
    claims: [{ client_row_ref: "one", data: { Group: "AHK", "Member ID": "M1", DOS: "01/02/2026" } }],
    credentials: { ...account, group: "IUMG" },
  });
  assert.equal(prepared.claimCount, 1);
});

test("Waystar account verification answers are placed in its existing workbook sheet", async () => {
  const prepared = await prepareGenericClaimStatusServiceInput("waystar", {
    claims: [{ client_row_ref: "one", data: { "Patient Name": "Jane Doe", "Responsible Payer": "Aetna", DOS: "01/02/2026" } }],
    credentials: { ...account, verification_answers: [{ question: "Favorite food?", answer: "Test answer" }] },
  });
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(prepared.files[1].buffer as unknown as Parameters<typeof book.xlsx.load>[0]);
  assert.equal(book.getWorksheet("Verification")?.getRow(2).getCell(2).value, "Favorite food?");
  assert.equal(book.getWorksheet("Verification")?.getRow(2).getCell(3).value, "Test answer");
});

test("multiple detail rows group into one submitted claim result", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Output");
  sheet.addRow(["Input Row", "Bot Status", "Bot Claim Status", "Final status"]);
  sheet.addRow([2, "Success", "Paid", "Line 1 paid"]);
  sheet.addRow([2, "Success", "Denied", "Line 2 denied"]);
  sheet.addRow([3, "No results", "", "No claims found"]);
  const summary = await normalizeGenericClaimStatusWorkbook(
    new Uint8Array(await book.xlsx.writeBuffer()), ["one", "two"], "blue-shield",
  );
  assert.deepEqual(summary.row_results.map((row) => [row.client_row_ref, row.status]), [["one", "SUCCESS"], ["two", "NO_MATCH"]]);
  assert.equal(summary.row_results[0].result.detail_rows?.length, 2);
  assert.equal(summary.finalized_count, 2);
});

test("missing output row stays incomplete and does not advance finalized claim count", async () => {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("Output");
  sheet.addRow(["sno", "status", "Final Status"]);
  sheet.addRow(["1.", "Success", "Paid"]);
  const summary = await normalizeGenericClaimStatusWorkbook(
    new Uint8Array(await book.xlsx.writeBuffer()), ["one", "two"], "waystar",
  );
  assert.deepEqual(summary.row_results.map((row) => row.status), ["SUCCESS", "INCOMPLETE"]);
  assert.equal(summary.finalized_count, 1);
});

test("Waystar continuation lines and its one-based error rows belong to one claim", async () => {
  const book = new ExcelJS.Workbook();
  const output = book.addWorksheet("Output");
  output.addRow(["sno", "status", "Final Status"]);
  output.addRow(["1.", "paid", "First service line"]);
  output.addRow(["", "denial", "Second service line"]);
  const errors = book.addWorksheet("Error");
  errors.addRow(["Input Row", "Error Message"]);
  errors.addRow([2, "Second claim failed"]);
  const summary = await normalizeGenericClaimStatusWorkbook(
    new Uint8Array(await book.xlsx.writeBuffer()), ["one", "two"], "waystar",
  );
  assert.equal(summary.row_results[0].result.detail_rows?.length, 2);
  assert.equal(summary.row_results[0].status, "SUCCESS");
  assert.equal(summary.row_results[1].status, "FAILED");
});

test("portal no_data result is a finalized no-match claim", async () => {
  const book = new ExcelJS.Workbook();
  const output = book.addWorksheet("Output");
  output.addRow(["input_row_id", "result", "final_status"]);
  output.addRow([2, "no_data", "No data found in portal"]);
  const summary = await normalizeGenericClaimStatusWorkbook(
    new Uint8Array(await book.xlsx.writeBuffer()), ["one"], "all-care",
  );
  assert.equal(summary.row_results[0].status, "NO_MATCH");
  assert.equal(summary.finalized_count, 1);
});
