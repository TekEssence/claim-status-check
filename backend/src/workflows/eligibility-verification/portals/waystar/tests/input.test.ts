import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  readWaystarEligibilityWorkbook,
  routeWaystarRowsByPayer,
} from "../input";

test("routes a mixed workbook to payer batches using Primary Insurance Name", () => {
  const routing = routeWaystarRowsByPayer([
    {
      "Primary Insurance Name": "Traditional Medicare Part B",
      "Member ID": "MED-1",
    },
    {
      "Primary Insurance Name": "ARP Health Plan",
      "Member ID": "ARP-1",
    },
    {
      "Primary Insurance Name": "Medicare",
      "Member ID": "MED-2",
    },
  ]);

  assert.equal(routing.payerHeader, "Primary Insurance Name");
  assert.equal(routing.totalRows, 3);
  assert.deepEqual(
    routing.batches.map((batch) => [batch.payerId, batch.rows.length]),
    [["medicare", 2], ["arp", 1]],
  );
  assert.deepEqual(
    routing.batches[0].rows.map((row) => row.originalIndex),
    [2, 4],
  );
});

test("accepts normalized payer and insurance name header variants", () => {
  const payerRouting = routeWaystarRowsByPayer([{ PAYER: "MEDICARE ADVANTAGE" }]);
  const insuranceRouting = routeWaystarRowsByPayer([{ "Insurance-Name": "ARP" }]);

  assert.equal(payerRouting.batches[0].payerId, "medicare");
  assert.equal(insuranceRouting.batches[0].payerId, "arp");
});

test("detects flexible payer or insurance column names", () => {
  const payerStateRouting = routeWaystarRowsByPayer([
    { "Primary Insurance Payer State": "Blue Cross and Blue Shield of Texas" },
  ]);
  const planRouting = routeWaystarRowsByPayer([
    { "Current Insurance Plan": "Medicare Advantage" },
  ]);

  assert.equal(payerStateRouting.payerHeader, "Primary Insurance Payer State");
  assert.equal(payerStateRouting.batches[0].payerId, "blue-cross-blue-shield-texas");
  assert.equal(planRouting.payerHeader, "Current Insurance Plan");
  assert.equal(planRouting.batches[0].payerId, "medicare");
});

test("routes Blue Cross Blue Shield aliases to the correct Waystar payer option", () => {
  const routing = routeWaystarRowsByPayer([
    { Payer: "Blue Cross and Blue Shield of Texas" },
    { Payer: "BCBS Florida" },
    { Payer: "Florida Blue" },
  ]);

  assert.deepEqual(
    routing.batches.map((batch) => [batch.payerId, batch.rows.length]),
    [
      ["blue-cross-blue-shield-texas", 1],
      ["blue-cross-blue-shield-florida", 2],
    ],
  );
});

test("groups mixed payer rows so each payer can use its own portal flow", () => {
  const routing = routeWaystarRowsByPayer([
    { "Insurance Name": "Medicare" },
    { "Insurance Name": "Blue Cross and Blue Shield of Texas" },
    { "Insurance Name": "ARP Health Plan" },
    { "Insurance Name": "Blue Cross and Blue Shield of Florida" },
  ]);

  assert.deepEqual(
    routing.batches.map((batch) => [batch.payerId, batch.rows.length]),
    [
      ["medicare", 1],
      ["blue-cross-blue-shield-texas", 1],
      ["arp", 1],
      ["blue-cross-blue-shield-florida", 1],
    ],
  );
});

test("accepts Primary Ins Subscriber No as a BCBS payer source column", () => {
  const routing = routeWaystarRowsByPayer([
    { "Primary Ins Subscriber No": "Blue Cross and Blue Shield of Texas" },
  ]);

  assert.equal(routing.payerHeader, "Primary Ins Subscriber No");
  assert.equal(routing.batches[0].payerId, "blue-cross-blue-shield-texas");
});

test("routes BCBS rows using the BCBS_Payer_Mappings workbook sheet", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      { "Primary Ins Subscriber No": "Blue Cross and Blue Shield of Texas" },
      { "Primary Ins Subscriber No": "Blue Cross and Blue Shield of Florida" },
    ]),
    "Eligibility",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        "INPUT_Insurance payer_state": "Blue Cross and Blue Shield of Texas",
        "Payer portal": "BCBS Texas(SB900)",
      },
      {
        "INPUT_Insurance payer_state": "Blue Cross and Blue Shield of Florida",
        "Payer portal": "BCBS Florida(SB590)",
      },
    ]),
    "BCBS_Payer_Mappings",
  );

  const file = new File(
    [XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })],
    "eligibility.xlsx",
  );
  const routing = await readWaystarEligibilityWorkbook(file);

  assert.deepEqual(
    routing.batches.map((batch) => [batch.payerId, batch.rows.length]),
    [
      ["blue-cross-blue-shield-texas", 1],
      ["blue-cross-blue-shield-florida", 1],
    ],
  );
});

test("reports unsupported insurance rows without mixing them into payer batches", () => {
  const routing = routeWaystarRowsByPayer([
    { Payer: "Unknown Health Plan" },
    { Payer: "" },
    { Payer: "Medicare" },
  ]);

  assert.equal(routing.batches[0].rows.length, 1);
  assert.deepEqual(routing.unsupportedRows, [
    { rowIndex: 2, insuranceName: "Unknown Health Plan" },
    { rowIndex: 3, insuranceName: "" },
  ]);
});

test("requires a recognized insurance header", () => {
  assert.throws(
    () => routeWaystarRowsByPayer([{ Member: "123" }]),
    /missing payer column/i,
  );
});
