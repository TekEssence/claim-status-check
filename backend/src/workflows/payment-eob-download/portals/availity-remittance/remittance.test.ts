import assert from "node:assert/strict";
import test from "node:test";
import { parseRemittanceCsv } from "./remittance";

test("parses portal CSV with exact Availity Remittance columns", () => {
  const records = parseRemittanceCsv([
    "Check/EFT #,Payer,Payee,Check/EFT Date,Received by Availity,Check/EFT Amount",
    "0900562787,ARKANSAS TOTAL CARE,BENTONVILLE PEDIATRICS,07/15/2026,07/15/2026,$39.26",
  ].join("\n"));

  assert.deepEqual(records, [
    {
      checkNumber: "0900562787",
      payer: "ARKANSAS TOTAL CARE",
      payee: "BENTONVILLE PEDIATRICS",
      checkDate: "07/15/2026",
      receivedByAvaility: "07/15/2026",
      amount: "$39.26",
      raw: {
        "Check/EFT #": "0900562787",
        Payer: "ARKANSAS TOTAL CARE",
        Payee: "BENTONVILLE PEDIATRICS",
        "Check/EFT Date": "07/15/2026",
        "Received by Availity": "07/15/2026",
        "Check/EFT Amount": "$39.26",
      },
    },
  ]);
});
