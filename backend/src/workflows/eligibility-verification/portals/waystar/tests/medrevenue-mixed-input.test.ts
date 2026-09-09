import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { readWaystarEligibilityWorkbook, routeWaystarRowsByPayer } from "../input";
import { getWaystarProjectConfig } from "../config/projects";

test("MedRevenue recognizes the BLUESHILED spelling from the reported input", () => {
  const rows = [{ "Primary Insurance Name": "BLUESHILED", "Member ID": "A123" }];
  const routing = routeWaystarRowsByPayer(rows, { projectConfig: getWaystarProjectConfig("medrevenue") });
  assert.equal(routing.batches[0]?.payerId, "blue-shield");
  assert.deepEqual(routing.unsupportedRows, []);
  assert.equal(routeWaystarRowsByPayer(rows, { projectConfig: getWaystarProjectConfig("minimax") }).batches.length, 0);
});

test("one MedRevenue workbook routes interleaved primary payers using the member ID", async () => {
  const coverage = [
    ["Medicare", "1EG4TE5MK73"],
    ["Blue Cross", "ABC123"],
    ["Blue Shield", "X123"],
    ["United Healthcare", "912345678"],
    ["Medicare", "2EG4TE5MK73"],
    ["Unknown", "X456"],
    ["Regal Medical Group", "923456789"],
    ["Unknown", "A123"],
  ];
  const rows = coverage.map(([insurance, member]) => ({
    Payer: "Aetna",
    ID: "patient-record-id",
    "Subscriber ID": "different-subscriber-id",
    "Primary Insurance Name": insurance,
    "Member ID": member,
    DOB: "01/01/1980",
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "All payers");
  const file = new File([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], "mixed.xlsx");
  const routing = await readWaystarEligibilityWorkbook(file, undefined, getWaystarProjectConfig("medrevenue"));
  assert.equal(routing.payerHeader, "Primary Insurance Name");
  assert.equal(routing.totalRows, 8);
  assert.deepEqual(routing.batches.map((batch) => [batch.payerId, batch.rows.map((row) => row.originalIndex)]), [
    ["medicare", [2, 6]],
    ["bcbs-ppo", [3]],
    ["blue-shield", [4, 7]],
    ["united-healthcare-all-states", [5, 8]],
  ]);
  for (const batch of routing.batches) {
    for (const row of batch.rows) assert.equal(row.memberId, coverage[row.originalIndex - 2][1]);
  }
  assert.deepEqual(routing.unsupportedRows, [{ rowIndex: 9, insuranceName: "Unknown" }]);
});

test("MedRevenue workbook keeps Medicare primary coverage with 9-prefixed member IDs", async () => {
  const rows = ["LA Care", "IEHP"].map((secondary, index) => ({
    "Secondary Insurance": secondary,
    "Secondary Insurance ID#": "912345678",
    "Primary Insurance name": "Medicare",
    "MEMBER ID#": index === 0 ? "9AB1CD2EF34" : "9GH5JK6MN78",
  }));
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Eligibility");
  const file = new File([XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })], "medicare.xlsx");
  const routing = await readWaystarEligibilityWorkbook(file, undefined, getWaystarProjectConfig("medrevenue"));
  assert.equal(routing.payerHeader, "Primary Insurance name");
  assert.deepEqual(routing.unsupportedRows, []);
  assert.equal(routing.batches.length, 1);
  assert.equal(routing.batches[0].payerId, "medicare");
  assert.deepEqual(routing.batches[0].rows.map((row) => row.memberId), ["9AB1CD2EF34", "9GH5JK6MN78"]);
});

test("MedRevenue Medicare aliases take priority over the UHC member prefix", () => {
  for (const insurance of ["Medicare", " MEDICARE ", "Original Medicare", "Traditional Medicare", "Medicare Part A", "Medicare Part B"]) {
    const routing = routeWaystarRowsByPayer([
      { "Primary Insurance Name": insurance, "Member ID": "9AB1CD2EF34" },
    ], { projectConfig: getWaystarProjectConfig("medrevenue") });
    assert.equal(routing.batches[0]?.payerId, "medicare", insurance);
    assert.deepEqual(routing.unsupportedRows, []);
  }
});

test("MedRevenue does not replace a blank Member ID with an unrelated ID", () => {
  const routing = routeWaystarRowsByPayer([
    { ID: "X123", "Primary Insurance Name": "Medicare", "Member ID": "" },
  ], { projectConfig: getWaystarProjectConfig("medrevenue") });
  assert.equal(routing.batches[0].payerId, "medicare");
  assert.equal(routing.batches[0].rows[0].memberId, undefined);
});

test("Minimax retains its existing column selection and payer routing", () => {
  for (const projectConfig of [undefined, getWaystarProjectConfig("minimax")]) {
    const routing = routeWaystarRowsByPayer([
      { Payer: "Medicare", ID: "original-id", "Primary Insurance Name": "Blue Cross", "Member ID": "X123" },
    ], { projectConfig });
    assert.equal(routing.payerHeader, "Payer");
    assert.equal(routing.batches[0].payerId, "medicare");
    assert.equal(routing.batches[0].rows[0].memberId, "original-id");
  }
});
