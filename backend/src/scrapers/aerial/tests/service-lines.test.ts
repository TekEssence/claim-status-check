import assert from "node:assert/strict";
import test from "node:test";

function parseServiceLinesFromRows(rows: string[][]): string[] {
  const serviceCodes: string[] = [];

  for (const cellTexts of rows) {
    const isServiceLineRow =
      cellTexts.length >= 12 &&
      cellTexts[0] &&
      /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cellTexts[2]);

    if (isServiceLineRow) {
      serviceCodes.push(cellTexts[0].split(/\s+-\s+/)[0]);
    }
  }

  return serviceCodes;
}

test("Aerial service line detection keeps alphanumeric CPT/service codes", () => {
  const rows = [
    ["Service Code", "Qty", "Service Date", "Billed", "Contract", "Denied", "Copay", "Deductible", "Adjustment", "Withhold", "Paid", "Interest"],
    ["J0702 - INJ BETAMETHASONE", "4", "10/9/2025", "$68.16", "$27.84", "$40.32", "$5.57", "$0.00", "$0.00", "$0.00", "$22.27", "$0.00"],
    ["REJECTED RAVCA - ABOVE CONTRACT AMT"],
    ["20610-RT - ARTHROCNTS ASPIR", "1", "10/9/2025", "$313.15", "$68.74", "$244.41", "$0.00", "$0.00", "$0.00", "$0.00", "$68.74", "$0.00"],
    ["J2003-JZ - INJ LIDOCAINE HCL 1 MG", "3", "10/9/2025", "$0.21", "$0.00", "$0.15", "$0.00", "$0.00", "$0.00", "$0.00", "$0.06", "$0.00"],
    ["99214-25 - OFFICE OUTPT EST 25 MIN", "1", "10/9/2025", "$342.65", "$135.96", "$342.65", "$0.00", "$0.00", "$0.00", "$0.00", "$0.00", "$0.00"],
    ["", "", "", "$724.17", "$232.54", "$627.53", "$5.57", "$0.00", "$0.00", "$0.00", "$91.07", "$0.00"],
  ];

  assert.deepEqual(parseServiceLinesFromRows(rows), ["J0702", "20610-RT", "J2003-JZ", "99214-25"]);
});
