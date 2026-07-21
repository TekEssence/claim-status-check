import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { createWaystarOutputWorkbookBuffer } from "../output-writer";

test("Waystar output workbook matches the sample output structure", async () => {
  const buffer = await createWaystarOutputWorkbookBuffer({
    outputRows: [
      {
        sno: "7.",
        name: "JANE PATIENT",
        group: "OMEGA IPA",
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
        finalStatus: "DOS 06/15/2026: Checked waystar portal denied on 06/16/26 denial reason Charge exceeds fee schedule.. Acnt# 269048.",
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
    "GROUP",
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
    "Final Status",
    "Remarks",
  ]);

  const values = outputSheet.getRow(2).values.slice(1);
  assert.deepEqual(values, [
    "7.",
    "JANE PATIENT",
    "OMEGA IPA",
    "06/15/2026",
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
    "NA",
    "NA",
    "denial",
    "DOS 06/15/2026: Checked waystar portal denied on 06/16/26 denial reason Charge exceeds fee schedule.. Acnt# 269048.",
    "EOB extracted with denial codes.",
  ]);
});

test("writes multiple procedure lines on separate output rows", async () => {
  const buffer = await createWaystarOutputWorkbookBuffer({
    outputRows: [
      {
        sno: "1.",
        name: "JASON WILLIAM S",
        group: "ALPHA MEDICAL",
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
        finalStatus: "DOS 04/02/2026: Checked waystar portal denied on 05/07/26 denial reason 24Charges are covered under a capitation agreement/managed care plan.. Acnt# 269048.",
        remarks: "",
      },
      {
        sno: "",
        name: "JASON WILLIAM S",
        group: "ALPHA MEDICAL",
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
        finalStatus: "DOS 04/02/2026: Checked waystar portal paid on 05/07/26 PROV PD $70.00 with COINS/deduct of $0.00/$0.00 EFT/Check # ACH7322959. ACNT # 269048. Check Amount: $2753.43",
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

  assert.equal(outputSheet.getCell("B2").value, "JASON WILLIAM S");
  assert.equal(outputSheet.getCell("C2").value, "ALPHA MEDICAL");
  assert.equal(outputSheet.getCell("D2").value, "04/02/2026");
  assert.equal(outputSheet.getCell("J2").value, "99204");
  assert.equal(outputSheet.getCell("Q2").value, "CO-24");
  assert.equal(outputSheet.getCell("R2").value, "24Charges are covered under a capitation agreement/managed care plan.");
  assert.equal(outputSheet.getCell("S2").value, "CO-45");
  assert.equal(outputSheet.getCell("T2").value, "45Charge exceeds fee schedule/maximum allowable or contracted/legislated fee arrangement.");
  assert.equal(outputSheet.getCell("U2").value, "PR-3");
  assert.equal(outputSheet.getCell("V2").value, "3Co-payment Amount");
  assert.equal(outputSheet.getCell("X2").value, "DOS 04/02/2026: Checked waystar portal denied on 05/07/26 denial reason 24Charges are covered under a capitation agreement/managed care plan.. Acnt# 269048.");

  assert.equal(outputSheet.getCell("A3").value ?? "", "");
  assert.equal(outputSheet.getCell("B3").value, "JASON WILLIAM S");
  assert.equal(outputSheet.getCell("C3").value, "ALPHA MEDICAL");
  assert.equal(outputSheet.getCell("D3").value, "04/02/2026");
  assert.equal(outputSheet.getCell("J3").value, "51798");
  assert.equal(outputSheet.getCell("L3").value, "70.00");
  assert.equal(outputSheet.getCell("P3").value, "70.00");
  assert.equal(outputSheet.getCell("Q3").value, "NA");
  assert.equal(outputSheet.getCell("R3").value, "NA");
  assert.equal(outputSheet.getCell("X3").value, "DOS 04/02/2026: Checked waystar portal paid on 05/07/26 PROV PD $70.00 with COINS/deduct of $0.00/$0.00 EFT/Check # ACH7322959. ACNT # 269048. Check Amount: $2753.43");
});
