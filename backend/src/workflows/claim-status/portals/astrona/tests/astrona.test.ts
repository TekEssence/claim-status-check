import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { readAstronaCredentials, readAstronaInputRows, routeAstronaRows } from "../input";
import { astronaFinalStatus, astronaOutputRow, astronaOutputRows } from "../workbook";
import { astronaMemberNameSearchCandidates, astronaProviderPortalMatches, astronaResultDosMatches, astronaServiceLinesForDos, astronaServiceLinesForDosAndCpt } from "../portal";

function buffer(rows: Record<string, string>[]): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Sheet1");
  const value = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

test("Astrona routes claim rows by normalized Group and Payer", () => {
  const credentials = readAstronaCredentials(buffer([
    { Group: "ALPHA", Payer: "Payer One", URL: "portal.example/login", Username: "user", Password: "secret" },
  ]));
  const rows = readAstronaInputRows(buffer([
    { Group: "Alpha", Payer: "payer-one", "Member ID": "MEM-1", "Member Name": "Jane Doe" },
  ]));
  const routing = routeAstronaRows(rows, credentials);
  assert.equal(routing.batches.length, 1);
  assert.equal(routing.batches[0].rows[0].memberId, "MEM-1");
  assert.equal(routing.unmappedRows.length, 0);
});

test("Astrona selects the provider portal from Responsible Payer instead of login Group", () => {
  assert.equal(astronaProviderPortalMatches("ALPHA - Alpha Care Medical Group", "ALPHA", "1 - ALPHA CARE MEDICAL GROUP"), true);
  assert.equal(astronaProviderPortalMatches("AHC - Accountable Health Care", "AHC", "1 - ACCOUNTABLE HEALTH CARE IPA"), true);
  assert.equal(astronaProviderPortalMatches("ALPHA - Alpha Care Medical Group", "ALPHA", "1 - ACCOUNTABLE HEALTH CARE IPA"), false);
});

test("Astrona requires both Group and Payer for credential isolation", () => {
  const credentials = readAstronaCredentials(buffer([
    { Group: "ALPHA", Payer: "Payer One", URL: "https://one.example", Username: "one", Password: "secret" },
  ]));
  const rows = readAstronaInputRows(buffer([
    { Group: "ALPHA", Payer: "Payer Two", "Member ID": "MEM-2" },
  ]));
  assert.equal(routeAstronaRows(rows, credentials).unmappedRows.length, 1);
});

test("Astrona completes mixed Responsible Payer rows in first-seen payer batches", () => {
  const credentials = readAstronaCredentials(buffer([
    { Group: "ALPHA", Payer: "Payer 1", URL: "https://one.example", Username: "one", Password: "secret-1" },
    { Group: "ALPHA", Payer: "Payer 2", URL: "https://two.example", Username: "two", Password: "secret-2" },
  ]));
  const rows = readAstronaInputRows(buffer([
    { Group: "ALPHA", Payer: "ignored", "Responsible Payer": "Payer 1", "Member ID": "MEM-1" },
    { Group: "ALPHA", Payer: "ignored", "Responsible Payer": "Payer 2", "Member ID": "MEM-2" },
    { Group: "ALPHA", Payer: "ignored", "Responsible Payer": "Payer 1", "Member ID": "MEM-3" },
  ]));

  const routing = routeAstronaRows(rows, credentials);
  assert.deepEqual(routing.batches.map((batch) => batch.credentials.payer), ["Payer 1", "Payer 2"]);
  assert.deepEqual(routing.batches[0].rows.map((row) => row.memberId), ["MEM-1", "MEM-3"]);
  assert.deepEqual(routing.batches[1].rows.map((row) => row.memberId), ["MEM-2"]);
  assert.equal(routing.batches[0].credentials.username, "one");
  assert.equal(routing.batches[1].credentials.username, "two");
});

test("Astrona can use a unique Responsible Payer login without leaking across ambiguous payer rows", () => {
  const uniqueCredentials = readAstronaCredentials(buffer([
    { Group: "ALPHA", Payer: "Unique Payer", URL: "https://unique.example", Username: "unique", Password: "secret" },
  ]));
  const [row] = readAstronaInputRows(buffer([
    { Group: "Alpha Care Medical Group", "Responsible Payer": "Unique Payer", "Member ID": "MEM-4" },
  ]));
  assert.equal(routeAstronaRows([row], uniqueCredentials).batches[0].credentials.username, "unique");

  const ambiguousCredentials = readAstronaCredentials(buffer([
    { Group: "ALPHA", Payer: "Shared Payer", URL: "https://one.example", Username: "one", Password: "secret" },
    { Group: "BETA", Payer: "Shared Payer", URL: "https://two.example", Username: "two", Password: "secret" },
  ]));
  const [ambiguousRow] = readAstronaInputRows(buffer([
    { Group: "UNKNOWN", "Responsible Payer": "Shared Payer", "Member ID": "MEM-5" },
  ]));
  assert.equal(routeAstronaRows([ambiguousRow], ambiguousCredentials).unmappedRows.length, 1);
});

test("Astrona derives Paid and Denied from net amount", () => {
  assert.equal(astronaFinalStatus("$0.00"), "Denied");
  assert.equal(astronaFinalStatus("$12.34"), "Paid");
  assert.equal(astronaFinalStatus("($4.00)"), "Paid");
  assert.equal(astronaFinalStatus(""), "Unknown");
});

test("Astrona output keeps member data, all CPTs, and denial memo", () => {
  const row = readAstronaInputRows(buffer([{ Group: "ALPHA", Payer: "Payer One", "Member ID": "MEM-3", "Member Name": "John Doe" }]))[0];
  const output = astronaOutputRow(row, {
    claimNumber: "CLM-1", datePaid: "", checkNumber: "", portalStatus: "Denied", netAmount: "$0.00", cptCodes: ["99213", "80053"], memoLine1: "Not medically necessary", serviceLines: [],
  });
  assert.equal(output.member_id, "MEM-3");
  assert.equal(output.services_cpt, "99213; 80053");
  assert.equal(output.memo_line_1, "Not medically necessary");
  assert.equal(output.final_status, "Denied");
});

test("Astrona expands every aligned service line into its own output row", () => {
  const row = readAstronaInputRows(buffer([{ Group: "ALPHA", "Responsible Payer": "Payer One", "Member ID": "MEM-6" }]))[0];
  const output = astronaOutputRows(row, {
    claimNumber: "CLM-2", datePaid: "07/15/2026", checkNumber: "CHK-1", portalStatus: "Processed", netAmount: "", cptCodes: ["99213", "80053"], memoLine1: "",
    serviceLines: [
      { from: "07/01/2026", to: "07/01/2026", cpt: "99213", modifier: "25", diagCode: "R10.9", qty: "1", billed: "$100.00", coPay: "$10.00", coInsure: "$5.00", deductible: "$0.00", adjustment: "$85.00", net: "$0.00", memoLine1: "Denied line" },
      { from: "07/02/2026", to: "07/02/2026", cpt: "80053", modifier: "", diagCode: "Z00.0", qty: "1", billed: "$50.00", coPay: "$0.00", coInsure: "$0.00", deductible: "$0.00", adjustment: "$20.00", net: "$30.00", memoLine1: "" },
    ],
  });

  assert.equal(output.length, 2);
  assert.deepEqual(
    output.map((line) => [line.from, line.to, line.cpt, line.modifier, line.diag_code, line.qty, line.billed, line.co_pay, line.co_insure, line.deductible, line.adjustment, line.net, line.memo_line_1, line.final_status]),
    [
      ["07/01/2026", "07/01/2026", "99213", "25", "R10.9", "1", "$100.00", "$10.00", "$5.00", "$0.00", "$85.00", "$0.00", "Denied line", "Denied"],
      ["07/02/2026", "07/02/2026", "80053", "", "Z00.0", "1", "$50.00", "$0.00", "$0.00", "$0.00", "$20.00", "$30.00", "", "Paid"],
    ],
  );
});

test("Astrona reads input DOS and keeps every portal service line on the same DOS", () => {
  const [row] = readAstronaInputRows(buffer([{
    Group: "ALPHA", Payer: "Payer One", "Member ID": "MEM-7", "Date of Service": "7/1/2026",
  }]));
  assert.equal(row.dos, "7/1/2026");

  const matching = astronaServiceLinesForDos([
    { from: "07/01/2026", to: "07/01/2026", cpt: "99213", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$10.00", memoLine1: "" },
    { from: "7/1/2026", to: "7/1/2026", cpt: "80053", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$20.00", memoLine1: "" },
    { from: "07/02/2026", to: "07/02/2026", cpt: "85025", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$30.00", memoLine1: "" },
  ], row.dos);

  assert.deepEqual(matching.map((line) => line.cpt), ["99213", "80053"]);
});

test("Astrona progressively removes member initials and last name for search retries", () => {
  assert.deepEqual(astronaMemberNameSearchCandidates("Barrera, Vicky V"), ["Barrera, Vicky V", "Barrera, Vicky", "Vicky"]);
  assert.deepEqual(astronaMemberNameSearchCandidates("Marcela J Cardenas"), ["Marcela J Cardenas", "Marcela Cardenas", "Marcela"]);
});

test("Astrona isolates same-member same-DOS rows by input CPT", () => {
  const lines = [
    { from: "06/08/2025", to: "06/08/2025", cpt: "99210-OFFICE VISIT", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$10.00", memoLine1: "" },
    { from: "06/08/2025", to: "06/08/2025", cpt: "99212-OFFICE VISIT", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$20.00", memoLine1: "" },
  ];
  assert.deepEqual(astronaServiceLinesForDosAndCpt(lines, "6/8/25", "99210").map((line) => line.cpt), ["99210-OFFICE VISIT"]);
  assert.deepEqual(astronaServiceLinesForDosAndCpt(lines, "6/8/25", "99212").map((line) => line.cpt), ["99212-OFFICE VISIT"]);
});

test("Astrona result DOS matching supports exact dates and service ranges", () => {
  assert.equal(astronaResultDosMatches("06/08/2025", "6/8/25"), true);
  assert.equal(astronaResultDosMatches("06/01/2025 - 06/30/2025", "06/08/2025"), true);
  assert.equal(astronaResultDosMatches("06/01/2025 - 06/07/2025", "06/08/2025"), false);
});

test("Astrona service-line DOS matching accepts a DOS inside a From-To range", () => {
  const lines = [{ from: "04/20/2026", to: "04/23/2026", cpt: "99213", modifier: "", diagCode: "", qty: "1", billed: "", coPay: "", coInsure: "", deductible: "", adjustment: "", net: "$10.00", memoLine1: "" }];
  assert.equal(astronaServiceLinesForDos(lines, "04/22/2026").length, 1);
});
