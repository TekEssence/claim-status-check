import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import { createWaystarEligibilityOutputWorkbookBuffer } from "../output";

test("Waystar eligibility workbook applies Medicare and pharmacy output rules in the standard layout", async () => {
  const buffer = await createWaystarEligibilityOutputWorkbookBuffer(
    [
      {
        payerName: "Medicare",
        status: "completed",
        row: {
          originalIndex: 2,
          subscriberId: "SUB-12345",
          patientFirstName: "Bernard",
          patientLastName: "Collotty",
          dateOfBirth: "01/01/1950",
          raw: {
            "Pat F Name": "Bernard",
            "Pat L Name": "Collotty",
            "Subscriber No": "SUB-12345",
            DOB: "01/01/1950",
            Payer: "Medicare",
          },
        },
        result: {
          rowIndex: 2,
          payerId: "medicare",
          coverageStatus: "active",
          planName: "Medicare Part B",
          planStatus: "Active Coverage",
          benefits: [{ serviceType: "Health Benefit Plan Coverage", coverageStatus: "active" }],
          metadata: {
            bodyText: [
              "Coverage Status",
              "Active Coverage",
              "Eligibility Date",
              "03/01/2008",
              "Insurance Type",
              "Other Insurance - OT",
              "Benefit Date",
              "07/28/2000",
            ].join("\n"),
            portalFields: {
              planName: "Medicare Part B",
              planStatus: "Active Coverage",
              planDate: "03/01/2008",
              serviceType: "Health Benefit Plan Coverage",
              deductible: 283,
              deductibleRemaining: 0,
              deductibleMet: 283,
              coInsurance: "20.0% Visit",
            },
          },
        },
      },
      {
        payerName: "Medicare",
        status: "completed",
        row: {
          originalIndex: 3,
          subscriberId: "SUB-67890",
          patientFirstName: "Alice",
          patientLastName: "Stone",
          dateOfBirth: "02/02/1960",
          raw: {
            "Subscriber No": "SUB-67890",
            DOB: "02/02/1960",
            Payer: "Medicare of Texas",
          },
        },
        result: {
          rowIndex: 3,
          payerId: "medicare",
          coverageStatus: "active",
          planName: "Medicare Part B",
          planStatus: "Active Coverage",
          benefits: [{ serviceType: "Health Benefit Plan Coverage", coverageStatus: "active" }],
          metadata: {
            bodyText: [
              "Coverage Status",
              "Active Coverage",
              "Eligibility Date",
              "08/02/2026",
              "Insurance Type",
              "Other Insurance - OT",
              "Benefit Date",
              "08/02/2026",
            ].join("\n"),
            portalFields: {
              serviceType: "Health Benefit Plan Coverage",
              planName: "Medicare Part B",
              planStatus: "Active Coverage",
              planDate: "08/02/2026",
              deductible: 240,
              deductibleRemaining: 10,
              deductibleMet: 230,
              coInsurance: "20.0% Visit",
            },
          },
        },
      },
      {
        payerName: "Medicare",
        status: "completed",
        row: {
          originalIndex: 4,
          subscriberId: "SUB-33333",
          patientFirstName: "Rodney",
          patientLastName: "King",
          dateOfBirth: "12/30/1942",
          raw: {
            "Subscriber No": "SUB-33333",
            DOB: "12/30/1942",
            Payer: "Medicare",
          },
        },
        result: {
          rowIndex: 4,
          payerId: "medicare",
          coverageStatus: "active",
          planName: "Coverage Plan",
          planStatus: "Active Coverage",
          benefits: [{ serviceType: "Pharmacy", coverageStatus: "active" }],
          metadata: {
            bodyText: [
              "Coverage Status",
              "Active Coverage",
              "Eligibility Date",
              "08/02/2026",
            ].join("\n"),
            portalFields: {
              serviceType: "Pharmacy",
              planName: "Coverage Plan",
              planStatus: "Active Coverage",
              planDate: "08/02/2026",
              coInsurance: "20.0% Visit",
            },
          },
        },
      },
    ],
  );

  const workbook = XLSX.read(buffer, { type: "buffer" });
  assert.deepEqual(workbook.SheetNames, ["Input", "Output", "Audit Log", "Error Log"]);

  const outputRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Output, { defval: "" });

  assert.equal(outputRows[0]?.["Patient Name"], "Bernard Collotty");
  assert.equal(outputRows[0]?.DOB, "01/01/1950");
  assert.equal(outputRows[0]?.["Subscriber No"], "SUB-12345");
  assert.equal(outputRows[0]?.Portal, "Waystar");
  assert.equal(outputRows[0]?.Payer, "Medicare");
  assert.equal(outputRows[0]?.["Eligibility Row"], 2);
  assert.equal(outputRows[0]?.["Run Status"], "completed");
  assert.equal(outputRows[0]?.["Plan Name"], "Medicare Part B");
  assert.equal(outputRows[0]?.["Coverage Status"], "Active Coverage");
  assert.equal(outputRows[0]?.["Eff Date"], "03/01/2008");
  assert.equal(outputRows[0]?.["End Date"], "NA");
  assert.equal(outputRows[0]?.["Other Ins"], "Other Insurance - OT");
  assert.equal(outputRows[0]?.["Other Ins Eff Date"], "07/28/2000");
  assert.equal(outputRows[0]?.["Bot Insurance Type"], "Medicare");
  assert.equal(outputRows[0]?.Network, "NA");
  assert.equal(outputRows[0]?.Coinsurance, "NA");
  assert.equal(outputRows[0]?.Deductible, "NA");

  assert.equal(outputRows[1]?.["Patient Name"], "Alice Stone");
  assert.equal(outputRows[1]?.DOB, "02/02/1960");
  assert.equal(outputRows[1]?.["Subscriber No"], "SUB-67890");
  assert.equal(outputRows[1]?.Portal, "Waystar");
  assert.equal(outputRows[1]?.Payer, "Medicare of Texas");
  assert.equal(outputRows[1]?.["Eligibility Row"], 3);
  assert.equal(outputRows[1]?.["Run Status"], "completed");
  assert.equal(outputRows[1]?.["Plan Name"], "Medicare Part B");
  assert.equal(outputRows[1]?.["Coverage Status"], "Active Coverage");
  assert.equal(outputRows[1]?.["Eff Date"], "08/02/2026");
  assert.equal(outputRows[1]?.["Other Ins"], "Other Insurance - OT");
  assert.equal(outputRows[1]?.["Bot Insurance Type"], "Medicare of Texas");
  assert.equal(outputRows[1]?.Network, "NA");
  assert.equal(outputRows[1]?.Coinsurance, "20.0% Visit");
  assert.equal(outputRows[1]?.Copay, "NA");
  assert.equal(outputRows[1]?.Deductible, 240);
  assert.equal(outputRows[1]?.["Deductible Met"], 230);

  assert.equal(outputRows[2]?.["Patient Name"], "Rodney King");
  assert.equal(outputRows[2]?.DOB, "12/30/1942");
  assert.equal(outputRows[2]?.["Subscriber No"], "SUB-33333");
  assert.equal(outputRows[2]?.Portal, "Waystar");
  assert.equal(outputRows[2]?.Payer, "Medicare");
  assert.equal(outputRows[2]?.["Eligibility Row"], 4);
  assert.equal(outputRows[2]?.["Run Status"], "completed");
  assert.equal(outputRows[2]?.["Plan Name"], "Coverage Plan");
  assert.equal(outputRows[2]?.["Service Type"], "Pharmacy");
  assert.equal(outputRows[2]?.["Coverage Status"], "Active Coverage");
  assert.equal(outputRows[2]?.["Bot Insurance Type"], "NA");
  assert.equal(outputRows[2]?.Coinsurance, "NA");
  assert.equal(outputRows[2]?.["Eff Date"], "NA");

  const styledWorkbook = new ExcelJS.Workbook();
  await styledWorkbook.xlsx.load(buffer);
  const outputSheet = styledWorkbook.getWorksheet("Output");
  assert.ok(outputSheet);
  assert.equal(outputSheet.getCell("A1").value, "Patient Name");
  assert.equal(outputSheet.getCell("M1").value, "Coverage Status");
  assert.equal(outputSheet.getCell("A1").fill?.fgColor?.argb, "FF5B9BD5");
});

test("Waystar eligibility workbook keeps the standard output layout for non-Medicare batches", async () => {
  const buffer = await createWaystarEligibilityOutputWorkbookBuffer([
    {
      payerName: "Blue Shield",
      status: "completed",
      row: {
        originalIndex: 5,
        subscriberId: "SUB-99999",
        patientFirstName: "Chris",
        patientLastName: "Moss",
        dateOfBirth: "03/03/1970",
        raw: {
          "Subscriber No": "SUB-99999",
          DOB: "03/03/1970",
          Payer: "Blue Shield",
        },
      },
      result: {
        rowIndex: 5,
        payerId: "blue-cross-blue-shield",
        coverageStatus: "active",
        planName: "Blue Shield PPO",
        planStatus: "Active Coverage",
        effectiveDate: "01/01/2026",
        benefits: [{ serviceType: "Professional (Physician) Visit - Office", coverageStatus: "active" }],
        metadata: {
          bodyText: ["Coverage Status", "Active Coverage", "Eligibility Date", "01/01/2026"].join("\n"),
          portalFields: {
            serviceType: "Professional (Physician) Visit - Office",
            planName: "Blue Shield PPO",
            planStatus: "Active Coverage",
            planDate: "01/01/2026",
          },
        },
      },
    },
  ]);

  const workbook = XLSX.read(buffer, { type: "buffer" });
  const outputRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets.Output, { defval: "" });

  assert.equal(outputRows[0]?.["Patient Name"], "Chris Moss");
  assert.equal(outputRows[0]?.Payer, "Blue Shield");
  assert.equal(outputRows[0]?.["Coverage Status"], "Active Coverage");
  assert.equal(outputRows[0]?.["Bot Insurance Type"], "Blue Shield");
});
