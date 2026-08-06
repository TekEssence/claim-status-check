import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeClaimDetail, normalizeSummaryItems } from "./normalizers";

describe("Availity network normalizers", () => {
  it("normalizes summary search items into row-like data", () => {
    const rows = normalizeSummaryItems([{
      claimNumber: "Z174CXE02414",
      status: "PAID",
      fromDate: "2026-06-02",
      toDate: "2026-06-02",
      amounts: {
        BILLED: { value: "563.0" },
        INSURANCE_TOTAL_PAID: { value: "159.09" },
      },
      subscriber: {
        memberId: "UZ190520201",
      },
      patient: {
        accountNumber: "4060/011807",
      },
    }]);

    assert.equal(rows[0].claimNumber, "Z174CXE02414");
    assert.equal(rows[0].status, "PAID");
    assert.equal(rows[0].serviceDate, "06/02/2026");
    assert.equal(rows[0].billedAmount, "$563.00");
    assert.equal(rows[0].insurancePaidAmount, "$159.09");
    assert.equal(rows[0].memberId, "UZ190520201");
    assert.equal(rows[0].patientAccountNumber, "4060/011807");
    assert.equal(rows[0].claimIndex, 0);
  });

  it("normalizes claim detail and service lines", () => {
    const detail = normalizeClaimDetail({
      claimNumber: "Z174CXE02414",
      status: "PAID",
      receivedDate: "2026-06-23",
      fromDate: "2026-06-02",
      toDate: "2026-06-02",
      amounts: {
        BILLED: { value: "563.0" },
        INSURANCE_TOTAL_PAID: { value: "159.09" },
      },
      remittanceInfo: [{
        checkAmount: "159.09",
        checkNumber: "0000646608",
        checkDate: "2026-06-30",
      }],
      serviceLines: [{
        lineNumber: 1,
        procedureCode: "99204",
        procedureCodeDescription: "OFFICE/OUTPATIENT NEW MODERATE MDM 45 MINUTES",
        status: "PAID",
        fromDate: "2026-06-02",
        effectiveDate: "2026-06-30T00:00:00Z",
        amounts: {
          BILLED: { value: "530.0" },
          INSURANCE_TOTAL_PAID: { value: "159.09" },
          COPAY: { value: "8.0" },
          COINSURANCE: { value: "0.0" },
          DEDUCTIBLE: { value: "0.0" },
        },
        remarks: [{
          code: "45",
          reason: "Charge exceeds fee schedule.",
        }, {
          code: "3",
          reason: "Co-payment Amount",
        }],
      }],
    });

    assert.equal(detail.claimNumber, "Z174CXE02414");
    assert.equal(detail.claimStatus, "PAID");
    assert.equal(detail.receivedDate, "06/23/2026");
    assert.equal(detail.checkNumber, "0000646608");
    assert.equal(detail.checkDate, "06/30/2026");
    assert.equal(detail.checkAmount, "$159.09");
    assert.equal(detail.lines[0].procedureCode, "99204");
    assert.equal(detail.lines[0].paid, "$159.09");
    assert.equal(detail.lines[0].copay, "$8.00");
    assert.equal(detail.lines[0].remarkCode, "45, 3");
    assert.equal(detail.lines[0].description, "45: Charge exceeds fee schedule. and 3: Co-payment Amount");
  });
});
