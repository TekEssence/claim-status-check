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
    { "Primary Insurance Payer State": "BCBS PPO" },
  ]);
  const planRouting = routeWaystarRowsByPayer([
    { "Current Insurance Plan": "Medicare Advantage" },
  ]);

  assert.equal(payerStateRouting.payerHeader, "Primary Insurance Payer State");
  assert.equal(payerStateRouting.batches[0].payerId, "bcbs-ppo");
  assert.equal(planRouting.payerHeader, "Current Insurance Plan");
  assert.equal(planRouting.batches[0].payerId, "medicare");
});

test("routes only BCBS PPO to the dedicated Waystar payer", () => {
  const routing = routeWaystarRowsByPayer([
    { Payer: "BCBS PPO", "Member ID": "PPO-123" },
    { Payer: "BCBS Florida", "Member ID": "FL-456" },
  ]);

  assert.deepEqual(routing.batches.map((batch) => [batch.payerId, batch.rows.length]), [
    ["bcbs-ppo", 1],
  ]);
  assert.deepEqual(routing.unsupportedRows.map((row) => row.insuranceName), ["BCBS Florida"]);
});
test("groups mixed payer rows so each payer can use its own portal flow", () => {
  const routing = routeWaystarRowsByPayer([
    { "Insurance Name": "Medicare" },
    { "Insurance Name": "BCBS PPO" },
    { "Insurance Name": "ARP Health Plan" },
  ]);

  assert.deepEqual(
    routing.batches.map((batch) => [batch.payerId, batch.rows.length]),
    [
      ["medicare", 1],
      ["bcbs-ppo", 1],
      ["arp", 1],
    ],
  );
});

test("does not confuse Primary Ins Subscriber No with the payer column", () => {
  assert.throws(() => routeWaystarRowsByPayer([
    { "Primary Ins Subscriber No": "SUB-123" },
  ]), /missing payer column/i);
});

test("maps BCBS PPO to the BCBS Florida portal option", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      { "Primary Insurance Name": "BCBS PPO", "Primary Ins Subscriber No": "PPO-123" },
    ]),
    "Eligibility",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        "INPUT_Insurance payer_state": "BCBS PPO",
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

  assert.deepEqual(routing.batches.map((batch) => [batch.payerId, batch.rows.length]), [
    ["bcbs-ppo", 1],
  ]);
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
test("reads Relationship to Subscriber for dependent-patient inquiries", () => {
  const routing = routeWaystarRowsByPayer([{
    "Primary Insurance Name": "BCBS PPO",
    "Member ID": "SUB-100",
    "Patient First Name": "Dependent",
    "Patient Last Name": "Member",
    "Patient DOB": "01/02/2010",
    "Relationship to Subscriber": "Child",
  }]);

  assert.equal(routing.batches[0]?.rows[0]?.relationshipToSubscriber, "Child");
});

test("routes Excel-configured Van Lang IPA rows to Amerigroup Wellpoint", async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      { "Primary Insurance Name": "Van Lang IPA", "Primary Ins Subscriber No": "VL-123" },
    ]),
    "Eligibility",
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        "INPUT_Insurance payer_state": "Van Lang IPA",
        "Payer portal": "Amerigroup Wellpoint (WLPNT)",
      },
    ]),
    "Payer_Mappings",
  );

  const file = new File(
    [XLSX.write(workbook, { type: "buffer", bookType: "xlsx" })],
    "eligibility.xlsx",
  );
  const routing = await readWaystarEligibilityWorkbook(file);

  assert.deepEqual(
    routing.batches.map((batch) => [batch.payerId, batch.rows.length]),
    [["amerigroup-wellpoint", 1]],
  );
});
test("reads Payer_Mappings from the separate login workbook", async () => {
  const inputWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    inputWorkbook,
    XLSX.utils.json_to_sheet([
      { "Primary Insurance Name": "VICARE Health IPA", "Primary Ins Subscriber No": "VI-123" },
      { "Primary Insurance Name": "Integranet", "Primary Ins Subscriber No": "IN-456" },
    ]),
    "Eligibility",
  );

  const loginWorkbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    loginWorkbook,
    XLSX.utils.json_to_sheet([{ Portal: "Waystar", Payer: "Amerigroup" }]),
    "Credentials",
  );
  XLSX.utils.book_append_sheet(
    loginWorkbook,
    XLSX.utils.json_to_sheet([
      { "INPUT_Insurance payer_state": "VICARE Health IPA", "Payer portal": "Amerigroup Wellpoint(WLPNT)" },
      { "INPUT_Insurance payer_state": "Integranet", "Payer portal": "Amerigroup Wellpoint(WLPNT)" },
    ]),
    "Payer_Mappings",
  );

  const inputFile = new File(
    [XLSX.write(inputWorkbook, { type: "buffer", bookType: "xlsx" })],
    "eligibility.xlsx",
  );
  const loginFile = new File(
    [XLSX.write(loginWorkbook, { type: "buffer", bookType: "xlsx" })],
    "login.xlsx",
  );
  const routing = await readWaystarEligibilityWorkbook(inputFile, loginFile);

  assert.deepEqual(
    routing.batches.map((batch) => [batch.payerId, batch.rows.length]),
    [["amerigroup-wellpoint", 2]],
  );
  assert.equal(routing.unsupportedRows.length, 0);
});
test("uses Payer_Mappings to distinguish AARP from United Healthcare with the same 87726 id", () => {
  const rows = [
    { "Primary Insurance Name": "AARP Medicare Complete", "Primary Ins Subscriber No": "AARP-1" },
    { "Primary Insurance Name": "United Healthcare of All States", "Primary Ins Subscriber No": "UHC-1" },
  ];
  const routing = routeWaystarRowsByPayer(rows, {
    payerMappings: [
      {
        inputInsurancePayerState: "AARP Medicare Complete",
        payerPortal: "AARP Medicare Advantage Choice Plan (87726)",
      },
      {
        inputInsurancePayerState: "United Healthcare of All States",
        payerPortal: "United Healthcare(87726)",
      },
    ],
  });

  assert.deepEqual(routing.batches.map((batch) => batch.payerId), [
    "aarp-medicare-complete",
    "united-healthcare-all-states",
  ]);
});

test("does not bypass an invalid configured payer mapping", () => {
  const routing = routeWaystarRowsByPayer(
    [{ "Primary Insurance Name": "AARP Medicare Complete", "Primary Ins Subscriber No": "AARP-1" }],
    {
      payerMappings: [{
        inputInsurancePayerState: "AARP Medicare Complete",
        payerPortal: "Wrong Unsupported Portal Payer",
      }],
    },
  );

  assert.equal(routing.batches.length, 0);
  assert.equal(routing.unsupportedRows.length, 1);
});
