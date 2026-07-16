import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { createWaystarOutputWorkbookBuffer } from "../output-writer";

test("Waystar output workbook matches the sample output structure", async () => {
  const buffer = await createWaystarOutputWorkbookBuffer({
    outputRows: [
      {
        sno: "7.",
        name: "Jane Patient",
        servDate: "2026-06-15",
        icn: "ICN12345",
        acnt: "269048",
        eft: "ACH7322959",
        productionDate: "2026-06-16",
        checkDate: "2026-06-16",
        proc: "99213",
        checkAmt: "2753.43",
        billed: "125.00",
        allowed: "100.00",
        deduct: "0.00",
        coins: "0.00",
        provPd: "100.00",
        denialCode1: "CO-45",
        denialReason1: "Charge exceeds fee schedule.",
        denialCode2: "PR-3",
        denialReason2: "Co-payment Amount",
        denialCode3: "",
        denialReason3: "",
        status: "denial",
        remarks: "EOB extracted with denial codes.",
      },
    ],
    errorRows: [],
    auditRows: [],
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const outputSheet = workbook.getWorksheet("Output");
  assert.ok(outputSheet);

  const headers = outputSheet.getRow(1).values
    .slice(1)
    .map((value) => String(value ?? ""));

  assert.deepEqual(headers, [
    "sno",
    "NAME",
    "SERV DATE",
    "ICN",
    "ACNT",
    "EFT",
    "PRODUCTION DATE",
    "CHECK DATE",
    "PROC",
    "CHECK AMT",
    "BILLED",
    "ALLOWED",
    "DEDUCT",
    "COINS",
    "PROV PD",
    "Denial Code1",
    "Denial Reason `",
    "Denial Code 2",
    "denial reason 2",
    "Denial Code 3",
    "denial reason 3",
    "status",
    "Remarks",
  ]);

  const values = outputSheet.getRow(2).values.slice(1);
  assert.deepEqual(values, [
    "7.",
    "Jane Patient",
    "2026-06-15",
    "ICN12345",
    "269048",
    "ACH7322959",
    "2026-06-16",
    "2026-06-16",
    "99213",
    "2753.43",
    "125.00",
    "100.00",
    "0.00",
    "0.00",
    "100.00",
    "CO-45",
    "Charge exceeds fee schedule.",
    "PR-3",
    "Co-payment Amount",
    "",
    "",
    "denial",
    "EOB extracted with denial codes.",
  ]);
});
