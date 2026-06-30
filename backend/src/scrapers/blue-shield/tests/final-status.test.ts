import assert from "node:assert/strict";
import test from "node:test";
import { alignClaimsToInputRows, buildBlueShieldFinalStatus } from "../claim-status-job";
import type { BlueShieldClaimSummary, BlueShieldInputRow, BlueShieldMemberWorkItem } from "../types";

function inputRow(overrides: Partial<BlueShieldInputRow> = {}): BlueShieldInputRow {
  return {
    inputRowId: 2,
    memberId: "ABC123",
    dos: "04/18/2026",
    cptCode: "99214",
    validationStatus: "valid",
    validationMessage: "",
    ...overrides,
  };
}

function claim(overrides: Partial<BlueShieldClaimSummary> = {}): BlueShieldClaimSummary {
  return {
    memberId: "ABC123",
    dosSearched: "04/18/2026",
    claimIndex: 1,
    listClaimStatusLastModified: "",
    claimNumber: "BSC123",
    claimType: "",
    datesOfService: "",
    eob: "",
    memberName: "",
    listMemberIdSubscriberId: "",
    providerName: "",
    claimAmountBilled: "",
    claimAmountPaid: "",
    patientResponsibility: "",
    detailDatesOfService: "",
    claimReceived: "04/19/2026",
    detailProvider: "",
    providerNumber: "",
    nationalProviderIdentifier: "",
    ipaMedGroup: "",
    planType: "",
    detailAmountBilled: "",
    allowedAmount: "",
    detailPatientResponsibility: "",
    detailAmountPaid: "",
    checkEftNumber: "",
    checkEftDate: "",
    checkEftStatus: "",
    checkEftAmount: "",
    payeeName: "",
    payeeAddress: "",
    serviceLineNumber: "1",
    serviceLineDatesOfService: "04/18/2026-04/18/2026",
    placeOfService: "",
    units: "",
    procedureCode: "99214",
    modifier: "",
    serviceLineAmountBilled: "",
    serviceLineAllowedAmount: "",
    serviceLineDeductible: "",
    serviceLineCopay: "",
    serviceLineCoInsurance: "",
    serviceLineAmountPaid: "",
    claimNotes: "",
    claimStatus: "",
    serviceDate: "",
    receivedDate: "",
    paidDate: "",
    billedAmount: "",
    paidAmount: "",
    detailsText: "",
    sourceUrl: "",
    ...overrides,
  };
}

test("builds Blue Shield paid final status sentence", () => {
  assert.equal(
    buildBlueShieldFinalStatus(
      inputRow(),
      claim({
        claimStatus: "Paid",
        paidDate: "04/22/2026",
        serviceLineAmountPaid: "$78.27",
        checkEftNumber: "EFT123",
      }),
    ),
    "DOS 04/18/2026: Checked BSC portal claim received on 04/19/2026 paid on 04/22/2026 paid amount $78.27 EFT/Check # EFT123. Claim # BSC123.",
  );
});

test("builds Blue Shield denied final status sentence", () => {
  assert.equal(
    buildBlueShieldFinalStatus(
      inputRow(),
      claim({
        claimStatus: "Denied",
        listClaimStatusLastModified: "04/21/2026",
        claimNotes: "THE SUBMITTED DOCUMENTATION DOES NOT SUPPORT THE SERVICE(S) BILLED.|PLEASE SUBMIT RECORDS.",
      }),
    ),
    "DOS 04/18/2026: Checked BSC portal claim received on 04/19/2026 denied on 04/21/2026 denial reason THE SUBMITTED DOCUMENTATION DOES NOT SUPPORT THE SERVICE(S) BILLED. PLEASE SUBMIT RECORDS. Claim# BSC123.",
  );
});

test("aligns Blue Shield output rows by exact input DOS and CPT inside a wider member search range", () => {
  const rows = [
    inputRow({ inputRowId: 2, dos: "09/04/2024", cptCode: "99310" }),
    inputRow({ inputRowId: 3, dos: "09/12/2024", cptCode: "99310" }),
    inputRow({ inputRowId: 4, dos: "09/21/2024", cptCode: "99316" }),
  ];
  const member: BlueShieldMemberWorkItem = {
    memberId: "ABC123",
    dosValues: ["09/04/2024", "09/12/2024", "09/21/2024"],
    rowIds: [2, 3, 4],
    duplicateRowIds: [],
  };
  const outputRows = alignClaimsToInputRows(rows, member, [
    claim({
      serviceLineNumber: "1",
      dosSearched: "09/04/2024 - 09/21/2024",
      serviceLineDatesOfService: "09/04/2024-09/04/2024",
      procedureCode: "99310",
      claimNumber: "BSC-0904",
    }),
    claim({
      serviceLineNumber: "2",
      dosSearched: "09/04/2024 - 09/21/2024",
      serviceLineDatesOfService: "09/12/2024-09/12/2024",
      procedureCode: "99310",
      claimNumber: "BSC-0912",
    }),
    claim({
      serviceLineNumber: "2",
      dosSearched: "09/04/2024 - 09/21/2024",
      serviceLineDatesOfService: "09/12/2024-09/12/2024",
      procedureCode: "99310",
      claimNumber: "BSC-0912-DUP",
    }),
    claim({
      serviceLineNumber: "3",
      dosSearched: "09/04/2024 - 09/21/2024",
      serviceLineDatesOfService: "09/21/2024-09/21/2024",
      procedureCode: "99316",
      claimNumber: "BSC-0921",
    }),
  ]);

  assert.deepEqual(
    outputRows.map((row) => [row.inputRowId, row.botStatus, row.botClaimNumber, row.botServiceLineDatesOfService]),
    [
      [2, "Matched", "BSC-0904", "09/04/2024-09/04/2024"],
      [3, "Matched", "BSC-0912", "09/12/2024-09/12/2024"],
      [4, "Matched", "BSC-0921", "09/21/2024-09/21/2024"],
    ],
  );
});

test("writes every Blue Shield claim tied for the most recent matching date", () => {
  const rows = [inputRow({ inputRowId: 2, dos: "09/16/2024", cptCode: "99310" })];
  const member: BlueShieldMemberWorkItem = {
    memberId: "ABC123",
    dosValues: ["09/16/2024"],
    rowIds: [2],
    duplicateRowIds: [],
  };
  const outputRows = alignClaimsToInputRows(rows, member, [
    claim({
      claimNumber: "BSC-OLD",
      listClaimStatusLastModified: "09/10/2024",
      serviceLineNumber: "1",
      serviceLineDatesOfService: "09/16/2024-09/16/2024",
      procedureCode: "99310",
    }),
    claim({
      claimNumber: "BSC-RECENT-1",
      listClaimStatusLastModified: "09/12/2024",
      serviceLineNumber: "2",
      serviceLineDatesOfService: "09/16/2024-09/16/2024",
      procedureCode: "99310",
      serviceLineAmountBilled: "$100.00",
    }),
    claim({
      claimNumber: "BSC-RECENT-2",
      listClaimStatusLastModified: "09/12/2024",
      serviceLineNumber: "3",
      serviceLineDatesOfService: "09/16/2024-09/16/2024",
      procedureCode: "99310",
      serviceLineAmountBilled: "$200.00",
    }),
  ]);

  assert.deepEqual(
    outputRows.map((row) => row.botClaimNumber),
    ["BSC-RECENT-1", "BSC-RECENT-2"],
  );
});
