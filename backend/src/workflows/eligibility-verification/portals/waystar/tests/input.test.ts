import assert from "node:assert/strict";
import test from "node:test";
import { routeWaystarRowsByPayer } from "../input";

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

test("accepts Primary Ins Subscriber No as a BCBS payer source column", () => {
  const routing = routeWaystarRowsByPayer([
    { "Primary Ins Subscriber No": "Blue Cross and Blue Shield of Texas" },
  ]);

  assert.equal(routing.payerHeader, "Primary Ins Subscriber No");
  assert.equal(routing.batches[0].payerId, "blue-cross-blue-shield-texas");
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
