import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { readAllCareCredentials, readAllCareInputRows, routeAllCareRows } from "../input";
import { allCareFinalStatus, allCareFinalStatusText, allCareOutputRow, allCareOutputRows } from "../workbook";
import { allCareClaimNameMatches, allCareMemberNameSearchCandidates, allCareProviderPortalMatches, allCareResultDosMatches, allCareServiceLinesForDos, allCareServiceLinesForDosAndCpt } from "../portal";

function buffer(rows: Record<string, string>[]): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Sheet1");
  const value = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

test("AllCare routes claim rows by normalized Group and Payer", () => {
  const credentials = readAllCareCredentials(buffer([
    { Group: "ALPHA", Payer: "Payer One", URL: "portal.example/login", Username: "user", Password: "secret" },
  ]));
  const rows = readAllCareInputRows(buffer([
    { Group: "Alpha", Payer: "payer-one", "Member ID": "MEM-1", "Member Name": "Jane Doe" },
  ]));
  const routing = routeAllCareRows(rows, credentials);
  assert.equal(routing.batches.length, 1);
  assert.equal(routing.batches[0].rows[0].memberId, "MEM-1");
  assert.equal(routing.unmappedRows.length, 0);
});

test("AllCare accepts Responsible Party as the input Responsible Payer header", () => {
  const credentials = readAllCareCredentials(buffer([
    { Group: "ALPHA", Payer: "Payer One", URL: "portal.example/login", Username: "user", Password: "secret" },
  ]));
  const rows = readAllCareInputRows(buffer([
    { Group: "ALPHA", "Responsible Party": "Payer One", "Member ID": "MEM-RP-1" },
  ]));

  assert.equal(rows[0].payer, "Payer One");
  assert.equal(rows[0].validationStatus, "valid");
  assert.equal(routeAllCareRows(rows, credentials).batches[0].rows[0].memberId, "MEM-RP-1");
});

test("AllCare accepts ID as the input Member ID header", () => {
  const rows = readAllCareInputRows(buffer([
    { Group: "ALPHA", "Responsible Party": "Payer One", ID: "MEM-ID-1" },
  ]));

  assert.equal(rows[0].memberId, "MEM-ID-1");
  assert.equal(rows[0].validationStatus, "valid");
});

test("AllCare selects the provider portal from Responsible Payer instead of login Group", () => {
  assert.equal(allCareProviderPortalMatches("ALPHA - Alpha Care Medical Group", "ALPHA", "1 - ALPHA CARE MEDICAL GROUP"), true);
  assert.equal(allCareProviderPortalMatches("AHC - Accountable Health Care", "AHC", "1 - ACCOUNTABLE HEALTH CARE IPA"), true);
  assert.equal(allCareProviderPortalMatches("ALPHA - Alpha Care Medical Group", "ALPHA", "1 - ACCOUNTABLE HEALTH CARE IPA"), false);
});

test("AllCare requires both Group and Payer for credential isolation", () => {
  const credentials = readAllCareCredentials(buffer([
    { Group: "ALPHA", Payer: "Payer One", URL: "https://one.example", Username: "one", Password: "secret" },
  ]));
  const rows = readAllCareInputRows(buffer([
    { Group: "ALPHA", Payer: "Payer Two", "Member ID": "MEM-2" },
  ]));
  assert.equal(routeAllCareRows(rows, credentials).unmappedRows.length, 1);
});

test("AllCare completes mixed Responsible Payer rows in first-seen payer batches", () => {
  const credentials = readAllCareCredentials(buffer([
    { Group: "ALPHA", Payer: "Payer 1", URL: "https://one.example", Username: "one", Password: "secret-1" },
    { Group: "ALPHA", Payer: "Payer 2", URL: "https://two.example", Username: "two", Password: "secret-2" },
  ]));
  const rows = readAllCareInputRows(buffer([
    { Group: "ALPHA", Payer: "ignored", "Responsible Payer": "Payer 1", "Member ID": "MEM-1" },
    { Group: "ALPHA", Payer: "ignored", "Responsible Payer": "Payer 2", "Member ID": "MEM-2" },
    { Group: "ALPHA", Payer: "ignored", "Responsible Payer": "Payer 1", "Member ID": "MEM-3" },
  ]));

  const routing = routeAllCareRows(rows, credentials);
  assert.deepEqual(routing.batches.map((batch) => batch.credentials.payer), ["Payer 1", "Payer 2"]);
  assert.deepEqual(routing.batches[0].rows.map((row) => row.memberId), ["MEM-1", "MEM-3"]);
  assert.deepEqual(routing.batches[1].rows.map((row) => row.memberId), ["MEM-2"]);
  assert.equal(routing.batches[0].credentials.username, "one");
  assert.equal(routing.batches[1].credentials.username, "two");
});

test("AllCare can use a unique Responsible Payer login without leaking across ambiguous payer rows", () => {
  const uniqueCredentials = readAllCareCredentials(buffer([
    { Group: "ALPHA", Payer: "Unique Payer", URL: "https://unique.example", Username: "unique", Password: "secret" },
  ]));
  const [row] = readAllCareInputRows(buffer([
    { Group: "Alpha Care Medical Group", "Responsible Payer": "Unique Payer", "Member ID": "MEM-4" },
  ]));
  assert.equal(routeAllCareRows([row], uniqueCredentials).batches[0].credentials.username, "unique");

  const ambiguousCredentials = readAllCareCredentials(buffer([
    { Group: "ALPHA", Payer: "Shared Payer", URL: "https://one.example", Username: "one", Password: "secret" },
    { Group: "BETA", Payer: "Shared Payer", URL: "https://two.example", Username: "two", Password: "secret" },
  ]));
  const [ambiguousRow] = readAllCareInputRows(buffer([
    { Group: "UNKNOWN", "Responsible Payer": "Shared Payer", "Member ID": "MEM-5" },
  ]));
  assert.equal(routeAllCareRows([ambiguousRow], ambiguousCredentials).unmappedRows.length, 1);
});

test("AllCare derives Paid and Denied from net amount", () => {
  assert.equal(allCareFinalStatus("$0.00"), "Denied");
  assert.equal(allCareFinalStatus("$12.34"), "Paid");
  assert.equal(allCareFinalStatus("($4.00)"), "Paid");
  assert.equal(allCareFinalStatus(""), "Unknown");
});

test("AllCare output keeps member data without legacy duplicate columns", () => {
  const row = readAllCareInputRows(buffer([{ Group: "ALPHA", Payer: "Payer One", "Member ID": "MEM-3", "Member Name": "John Doe" }]))[0];
  const output = allCareOutputRow(row, {
    claimNumber: "CLM-1", datePaid: "", checkNumber: "", portalStatus: "Denied", netAmount: "$0.00", cptCodes: ["99213", "80053"], memoLine1: "Not medically necessary", serviceLines: [],
  });
  assert.equal(output.member_id, "MEM-3");
  assert.equal(output.Proc, "");
  assert.equal(output.NetPay, "$0.00");
  assert.equal(output.claim_outcome, "Denied");
  assert.match(String(output.final_status), /Checked All Care portal/);
  assert.equal("cpt" in output, false);
  assert.equal("billed" in output, false);
  assert.equal("net" in output, false);
  assert.equal("net_amount" in output, false);
});

test("AllCare expands every aligned service line into its own output row", () => {
  const row = readAllCareInputRows(buffer([{ Group: "ALPHA", "Responsible Payer": "Payer One", "Member ID": "MEM-6" }]))[0];
  const output = allCareOutputRows(row, {
    claimNumber: "CLM-2", datePaid: "07/15/2026", checkNumber: "CHK-1", portalStatus: "Processed", netAmount: "", cptCodes: ["99213", "80053"], memoLine1: "",
    serviceLines: [
      { from: "07/01/2026", to: "07/01/2026", cpt: "99213", modifier: "25", diagCode: "R10.9", qty: "1", billed: "$100.00", coPay: "$10.00", coInsure: "$5.00", deductible: "$0.00", adjustment: "$85.00", net: "$0.00", memoLine1: "Denied line" },
      { from: "07/02/2026", to: "07/02/2026", cpt: "80053", modifier: "", diagCode: "Z00.0", qty: "1", billed: "$50.00", coPay: "$0.00", coInsure: "$0.00", deductible: "$0.00", adjustment: "$20.00", net: "$30.00", memoLine1: "" },
    ],
  });

  assert.equal(output.length, 2);
  assert.deepEqual(
    output.map((line) => [line["Svc Date"], line.Proc, line.Mod, line.Qty, line.Billed, line.Copay, line.Coins, line.Deductible, line.Adjust, line.NetPay, line.claim_outcome]),
    [
      ["07/01/2026", "99213", "25", "1", "$100.00", "$10.00", "$5.00", "$0.00", "$85.00", "$0.00", "Denied"],
      ["07/02/2026", "80053", "", "1", "$50.00", "$0.00", "$0.00", "$0.00", "$20.00", "$30.00", "Paid"],
    ],
  );
});

test("AllCare builds paid and denied final status narratives", () => {
  const [row] = readAllCareInputRows(buffer([{ Group: "ALPHA", Payer: "Payer One", "Member ID": "MEM-9", "Date of Service": "06/02/2025" }]));
  const line = { from: "06/02/2025", to: "06/02/2025", cpt: "99223", modifier: "", diagCode: "", qty: "1", billed: "$100.00", coPay: "$0.00", coInsure: "$0.00", deductible: "$0.00", adjustment: "$75.00", net: "$25.00", memoLine1: "" };
  const paid = allCareFinalStatusText(row, { claimNumber: "CLM-9", dateReceived: "06/09/2025", datePaid: "06/10/2025", checkNumber: "EFT9", portalStatus: "Paid", netAmount: "$25.00", cptCodes: ["99223"], memoLine1: "", serviceLines: [line] }, line);
  assert.equal(paid, "DOS 06/02/2025: Checked All Care portal claim received on 06/09/2025 paid on 06/10/2025 paid amount $25.00 EFT/Check # EFT9. Claim # CLM-9.");
  const deniedLine = { ...line, net: "$0.00", memoLine1: "Not covered" };
  const denied = allCareFinalStatusText(row, { claimNumber: "CLM-10", dateReceived: "06/09/2025", datePaid: "", dateDenied: "06/11/2025", checkNumber: "", portalStatus: "Denied", netAmount: "$0.00", cptCodes: ["99223"], memoLine1: "", serviceLines: [deniedLine] }, deniedLine);
  assert.equal(denied, "DOS 06/02/2025: Checked All Care portal claim received on 06/09/2025 denied on 06/11/2025 denial reason Not covered. Claim# CLM-10.");
});

test("AllCare outputs matched CARC and RARC descriptions and uses them as the denial reason", () => {
  const [row] = readAllCareInputRows(buffer([{ Group: "ALPHA", Payer: "Payer One", ID: "MEM-10", DOS: "01/28/2026", CPT: "99152" }]));
  const line = { from: "01/28/2026", to: "01/28/2026", cpt: "P- 99152", modifier: "", diagCode: "", qty: "1", billed: "$50.00", coPay: "$0.00", coInsure: "$0.00", deductible: "$0.00", adjustment: "$50.00", net: "$0.00", carc: "231-CO", rarc: "N19", carcDescription: "Mutually exclusive procedures", rarcDescription: "Procedure code incidental to primary procedure.", memoLine1: "" };
  const details = { claimNumber: "CLM-10", dateReceived: "02/12/2026", datePaid: "04/10/2026", checkNumber: "81011102", portalStatus: "Finalized", netAmount: "$0.00", cptCodes: ["P- 99152"], memoLine1: "", serviceLines: [line] };
  const [output] = allCareOutputRows(row, details);

  assert.equal(output["CARC Description"], "Mutually exclusive procedures");
  assert.equal(output["RARC Description"], "Procedure code incidental to primary procedure.");
  assert.match(String(output.final_status), /denial reason Mutually exclusive procedures \/ Procedure code incidental to primary procedure\./);
});

test("AllCare reads input DOS and keeps every portal service line on the same DOS", () => {
  const [row] = readAllCareInputRows(buffer([{
    Group: "ALPHA", Payer: "Payer One", "Member ID": "MEM-7", "Date of Service": "7/1/2026",
  }]));
  assert.equal(row.dos, "7/1/2026");

  const matching = allCareServiceLinesForDos([
    { from: "07/01/2026", to: "07/01/2026", cpt: "99213", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$10.00", memoLine1: "" },
    { from: "7/1/2026", to: "7/1/2026", cpt: "80053", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$20.00", memoLine1: "" },
    { from: "07/02/2026", to: "07/02/2026", cpt: "85025", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$30.00", memoLine1: "" },
  ], row.dos);

  assert.deepEqual(matching.map((line) => line.cpt), ["99213", "80053"]);
});

test("AllCare progressively removes member initials and last name for search retries", () => {
  assert.deepEqual(allCareMemberNameSearchCandidates("Barrera, Vicky V"), ["Barrera, Vicky V", "Barrera, Vicky", "Vicky"]);
  assert.deepEqual(allCareMemberNameSearchCandidates("Marcela J Cardenas"), ["Marcela J Cardenas", "Marcela Cardenas", "Marcela"]);
});

test("AllCare isolates same-member same-DOS rows by input CPT", () => {
  const lines = [
    { from: "06/08/2025", to: "06/08/2025", cpt: "99210-OFFICE VISIT", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$10.00", memoLine1: "" },
    { from: "06/08/2025", to: "06/08/2025", cpt: "99212-OFFICE VISIT", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$20.00", memoLine1: "" },
  ];
  assert.deepEqual(allCareServiceLinesForDosAndCpt(lines, "6/8/25", "99210").map((line) => line.cpt), ["99210-OFFICE VISIT"]);
  assert.deepEqual(allCareServiceLinesForDosAndCpt(lines, "6/8/25", "99212").map((line) => line.cpt), ["99212-OFFICE VISIT"]);
});

test("AllCare result DOS matching supports exact dates and service ranges", () => {
  assert.equal(allCareResultDosMatches("06/08/2025", "6/8/25"), true);
  assert.equal(allCareResultDosMatches("06/01/2025 - 06/30/2025", "06/08/2025"), true);
  assert.equal(allCareResultDosMatches("06/01/2025 - 06/07/2025", "06/08/2025"), false);
});

test("AllCare service-line DOS matching accepts a DOS inside a From-To range", () => {
  const lines = [{ from: "04/20/2026", to: "04/23/2026", cpt: "99213", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$10.00", memoLine1: "" }];
  assert.equal(allCareServiceLinesForDos(lines, "04/22/2026").length, 1);
});

test("AllCare keeps detail lines when DOS was matched in the result grid and detail omits DOS", () => {
  const lines = [{ from: "", to: "", cpt: "99214", modifier: "", diagCode: "", qty: "1", billed: "$200.00", coPay: "$0.00", coInsure: "$0.00", deductible: "$0.00", adjustment: "$0.00", net: "$125.00", memoLine1: "" }];
  assert.equal(allCareServiceLinesForDosAndCpt(lines, "04/23/2026", "99214").length, 1);
});

test("AllCare member matching tolerates middle initials and suffixes", () => {
  const details = { memberName: "Doe, Jane M.", claimNumber: "", datePaid: "", checkNumber: "", portalStatus: "", netAmount: "", cptCodes: [], memoLine1: "", serviceLines: [] };
  const row = readAllCareInputRows(buffer([{ Group: "ALPHA", Payer: "Payer One", "Member ID": "MEM-8", "Member Name": "Jane Doe" }]))[0];
  assert.equal(allCareClaimNameMatches(details, row), true);
});
