import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import {
  readWaystarEligibilityWorkbook,
  routeWaystarRowsByPayer,
  splitPatientName,
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

test("reads abbreviated patient and subscriber headers from the workbook", () => {
  const routing = routeWaystarRowsByPayer([
    {
      "Primary Insurance Name": "Medicare",
      "Primary Ins Subscriber No": "SUB-123",
      "Pat F Name": "John",
      "Pat L Name": "Doe",
      "Pat Birthdate": "01/02/1950",
      Date: "07/09/2026",
    },
  ]);

  const row = routing.batches[0]?.rows[0];
  assert.equal(row?.memberId, "SUB-123");
  assert.equal(row?.subscriberId, "SUB-123");
  assert.equal(row?.patientFirstName, "John");
  assert.equal(row?.patientLastName, "Doe");
  assert.equal(row?.dateOfBirth, "01/02/1950");
  assert.equal(row?.dateOfService, "07/09/2026");
});

test("accepts all requested eligibility input header aliases", () => {
  const cases = [
    { payerHeader: "Primary Insurance Name", memberHeader: "Primary Ins Subscriber No", firstHeader: "First Name", lastHeader: "Last Name", dobHeader: "DOB" },
    { payerHeader: "Insurance Name", memberHeader: "Subscriber ID", firstHeader: "Patient F Name", lastHeader: "Patient Last Name", dobHeader: "Date of Birth" },
    { payerHeader: "Insurance", memberHeader: "Member ID", firstHeader: "Patient First Name", lastHeader: "Patient L Name", dobHeader: "Pat Birthdate" },
    { payerHeader: "Payer", memberHeader: "Subscriber No", firstHeader: "Pat F Name", lastHeader: "Pat L Name", dobHeader: "Patient Birthdate" },
    { payerHeader: "Primary Insurance Name", memberHeader: "ID", firstHeader: "First Name", lastHeader: "Last Name", dobHeader: "Patient DOB" },
    { payerHeader: "Primary Insurance Name", memberHeader: "Member ID", firstHeader: "First Name", lastHeader: "Last Name", dobHeader: "Birthdate" },
  ];

  for (const aliases of cases) {
    const row = {
      [aliases.payerHeader]: "Medicare",
      [aliases.memberHeader]: "SUB-999",
      [aliases.firstHeader]: "Jane",
      [aliases.lastHeader]: "Doe",
      [aliases.dobHeader]: "02/03/1960",
    };
    const parsed = routeWaystarRowsByPayer([row]).batches[0]?.rows[0];
    assert.equal(parsed?.memberId, "SUB-999", aliases.memberHeader);
    assert.equal(parsed?.patientFirstName, "Jane", aliases.firstHeader);
    assert.equal(parsed?.patientLastName, "Doe", aliases.lastHeader);
    assert.equal(parsed?.dateOfBirth, "02/03/1960", aliases.dobHeader);
  }
});

test("reads common Medicare-style headers including Patient Name and Patient DOB", () => {
  const routing = routeWaystarRowsByPayer([
    {
      "Primary Insurance Name": "Medicare",
      "Subscriber No": "SUB-456",
      "Patient Name": "DOE, JANE",
      "Patient DOB": "02/14/1955",
      "Service Type Codes": "30 - Health Benefit Plan Coverage",
    },
  ]);

  const row = routing.batches[0]?.rows[0];
  assert.equal(row?.memberId, "SUB-456");
  assert.equal(row?.subscriberId, "SUB-456");
  assert.equal(row?.patientFirstName, "JANE");
  assert.equal(row?.patientLastName, "DOE");
  assert.equal(row?.dateOfBirth, "02/14/1955");
  assert.equal(row?.serviceType, "30 - Health Benefit Plan Coverage");
});

test("splits space-delimited patient names when separate first and last name columns are absent", () => {
  assert.deepEqual(splitPatientName("John A Doe"), {
    firstName: "John A",
    lastName: "Doe",
  });
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

test("does not confuse Primary Ins Subscriber No with the payer column", () => {
  assert.throws(() => routeWaystarRowsByPayer([
    { "Primary Ins Subscriber No": "SUB-123" },
  ]), /missing payer column/i);
});

test("routes BCBS rows using the BCBS_Payer_Mappings workbook sheet", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      { "Primary Insurance Name": "Blue Cross and Blue Shield of Texas", "Primary Ins Subscriber No": "TX-123" },
      { "Primary Insurance Name": "Blue Cross and Blue Shield of Florida", "Primary Ins Subscriber No": "FL-456" },
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
