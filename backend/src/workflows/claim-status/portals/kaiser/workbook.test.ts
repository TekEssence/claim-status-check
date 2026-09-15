import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { createKaiserOutputWorkbookBuffer, type KaiserOutputRow } from "./workbook";

test("export excludes internal fields and duplicate input headers while preserving results", async () => {
  const row: KaiserOutputRow = {
    inputData: { "Member ID": "00001234", DOS: "4/4/26", CPT: "99232", "Patient Name": "Example, Jane", "Custom Note": "retain", Status: "old status", inputRowId: 2, memberId: "00001234", dos: "4/4/26", cptCodeRaw: "99232", cptCode: "99232", patientName: "Example, Jane", validationStatus: "valid", validationMessage: "" },
    inputRowId: 2, memberId: "00001234", dos: "4/4/26", cptCode: "99232", botStatus: "Success", botMessage: "Claim found.", claimStatus: "Paid", netPayable: "37.80",
    claimNumber: "example-claim", checkEft: "", paymentDate: "", paymentAmount: "",
    service: "99232", serviceFrom: "4/4/2026", serviceTo: "4/4/2026", modifiers: "", quantity: "1",
    claimCodes: "", billed: "220.00", allowed: "37.80", notCovered: "0.00", deductible: "0.00",
    coinsurance: "0.00", copay: "0.00", exceededBenefit: "0.00", patientTotal: "0.00",
    claimCodeDescriptionTable: "", denialCode: "", denialDate: "", denialSource: "", finalStatus: "Paid",
  };
  const bytes = await createKaiserOutputWorkbookBuffer({ outputRows: [row], auditRows: [] });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const sheet = workbook.getWorksheet("Output")!;
  const headers = (sheet.getRow(1).values as string[]).slice(1);
  for (const label of ["Member ID", "DOS", "CPT", "Patient Name", "Input Row"]) assert.equal(headers.filter(header => header === label).length, 1);
  for (const label of ["inputRowId", "memberId", "dos", "cptCodeRaw", "cptCode", "patientName", "validationStatus", "validationMessage"]) assert.equal(headers.includes(label), false);
  const value = (label: string) => sheet.getRow(2).getCell(headers.indexOf(label) + 1).value;
  assert.equal(value("Member ID"), "00001234");
  assert.equal(value("Custom Note"), "retain");
  assert.equal(value("Status"), "Paid");
  assert.equal(value("Input Status"), "old status");
  assert.equal(value("Net Payable"), "37.80");
});
