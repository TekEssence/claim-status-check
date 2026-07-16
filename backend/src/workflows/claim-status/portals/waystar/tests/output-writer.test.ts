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

test("writes multiple procedure lines on separate output rows", async () => {
  const buffer = await createWaystarOutputWorkbookBuffer({
    outputRows: [
      {
        sno: "1.",
        name: "Jason William S",
        servDate: "2026-04-02",
        icn: "60497156",
        acnt: "269048",
        eft: "ACH7322959",
        productionDate: "2026-05-07",
        checkDate: "2026-05-07",
        proc: "99204",
        checkAmt: "2753.43",
        billed: "500.00",
        allowed: "193.32",
        deduct: "0.00",
        coins: "0.00",
        provPd: "0.00",
        denialCode1: "CO-24",
        denialReason1: "24Charges are covered under a capitation agreement/managed care plan.",
        denialCode2: "CO-45",
        denialReason2: "45Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.",
        denialCode3: "PR-3",
        denialReason3: "3Co-payment Amount",
        status: "denial",
        remarks: "",
      },
      {
        sno: "",
        name: "Jason William S",
        servDate: "2026-04-02",
        icn: "60497156",
        acnt: "269048",
        eft: "ACH7322959",
        productionDate: "2026-05-07",
        checkDate: "2026-05-07",
        proc: "51798",
        checkAmt: "2753.43",
        billed: "70.00",
        allowed: "70.00",
        deduct: "0.00",
        coins: "0.00",
        provPd: "70.00",
        denialCode1: "",
        denialReason1: "",
        denialCode2: "",
        denialReason2: "",
        denialCode3: "",
        denialReason3: "",
        status: "paid",
        remarks: "",
      },
    ],
    errorRows: [],
    auditRows: [],
  });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const outputSheet = workbook.getWorksheet("Output");
  assert.ok(outputSheet);

  assert.equal(outputSheet.getCell("I2").value, "99204");
  assert.equal(outputSheet.getCell("P2").value, "CO-24");
  assert.equal(outputSheet.getCell("Q2").value, "24Charges are covered under a capitation agreement/managed care plan.");
  assert.equal(outputSheet.getCell("R2").value, "CO-45");
  assert.equal(outputSheet.getCell("S2").value, "45Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.");
  assert.equal(outputSheet.getCell("T2").value, "PR-3");
  assert.equal(outputSheet.getCell("U2").value, "3Co-payment Amount");

  assert.equal(outputSheet.getCell("A3").value ?? "", "");
  assert.equal(outputSheet.getCell("I3").value, "51798");
  assert.equal(outputSheet.getCell("K3").value, "70.00");
  assert.equal(outputSheet.getCell("O3").value, "70.00");
});
