import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { applyClaimRowUpdateToWorksheet, parseBotClaimDetails } from "../lib/claim-workbook";

function headerMap(worksheet: ExcelJS.Worksheet) {
  const headers: Record<string, number> = {};
  worksheet.getRow(1).eachCell((cell, colNum) => {
    headers[String(cell.value)] = colNum;
  });
  return headers;
}

function detailsText(records: Array<{ dos: string; received: string; check: string; amount: string }>) {
  return records.map((record) =>
    `Summary: [${record.dos} ${record.received} ${record.amount}] | Details: [Check #: [${record.check}]
Received Date: ${record.received}
Check Date: ${record.received}] | Status Info: [Paid in full]`
  ).join(" | ");
}

test("parses detail blocks with nested bracket values", () => {
  const [record] = parseBotClaimDetails(detailsText([
    { dos: "02/05/2026", received: "02/06/2026", check: "12345", amount: "$42.50" },
  ]));

  assert.deepEqual(record, {
    SummaryBlockDOS: "02/05/2026",
    SummaryBlockDate: "02/06/2026",
    CheckNumber: "[12345]",
    ReceivedDate: "02/06/2026",
    CheckDate: "02/06/2026",
    CheckAmount: "$42.50",
    OtherDetails: "Paid in full",
  });
});

test("writes bot status and split detail columns without overwriting existing columns", () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow([
    "Member Policy ID",
    "Date Of Service",
    "Existing Notes",
    "BotClaimDetails",
    "BotClaimStatusCheck",
    "BotClaimStatusCheckError",
    "Manual Review",
  ]);
  worksheet.addRow(["member-a", "02/05/2026", "keep-a", "", "", "", "manual-a"]);
  worksheet.addRow(["member-b", "02/07/2026", "keep-b", "", "", "", "manual-b"]);

  applyClaimRowUpdateToWorksheet(worksheet, {
    index: 0,
    update: {
      BotClaimDetails: detailsText([
        { dos: "02/05/2026", received: "02/06/2026", check: "111", amount: "$10.00" },
        { dos: "02/05/2026", received: "02/07/2026", check: "222", amount: "$20.00" },
      ]),
      BotClaimStatusCheck: "Success",
      BotClaimStatusCheckError: "",
    },
  });

  const headers = headerMap(worksheet);

  assert.equal(headers["Manual Review"], 7);
  assert.equal(worksheet.getRow(2).getCell(headers["BotClaimStatusCheck"]).value, "Success");
  assert.equal(worksheet.getRow(3).getCell(headers["BotClaimStatusCheck"]).value, "Success");
  assert.equal(worksheet.getRow(2).getCell(headers["SummaryBlockDOS"]).value, "02/05/2026");
  assert.equal(worksheet.getRow(3).getCell(headers["Check Number"]).value, "[222]");
  assert.equal(worksheet.getRow(2).getCell(headers["Check Amount"]).value, "$10.00");
  assert.equal(worksheet.getRow(3).getCell(headers["Check Amount"]).value, "$20.00");
  assert.equal(worksheet.getRow(2).getCell(headers["Manual Review"]).value, "manual-a");
  assert.equal(worksheet.getRow(3).getCell(headers["Manual Review"]).value, "manual-a");
  assert.equal(worksheet.getRow(4).getCell(headers["Member Policy ID"]).value, "member-b");
  assert.equal(worksheet.getRow(4).getCell(headers["Manual Review"]).value, "manual-b");
});

test("updates failed rows in bot columns even when no details are present", () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Member Policy ID", "Date Of Service"]);
  worksheet.addRow(["member-a", "bad-date"]);

  applyClaimRowUpdateToWorksheet(worksheet, {
    index: 0,
    update: {
      BotClaimStatusCheck: "Skipped",
      BotClaimStatusCheckError: "Skipped: Invalid Date of Service format: bad-date",
    },
  });

  const headers = headerMap(worksheet);

  assert.equal(worksheet.getRow(2).getCell(headers["BotClaimStatusCheck"]).value, "Skipped");
  assert.equal(
    worksheet.getRow(2).getCell(headers["BotClaimStatusCheckError"]).value,
    "Skipped: Invalid Date of Service format: bad-date",
  );
});

test("uses inserted row offset so later original claim rows are updated in the right worksheet row", () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Member Policy ID", "Date Of Service"]);
  worksheet.addRow(["member-a", "02/05/2026"]);
  worksheet.addRow(["member-b", "02/08/2026"]);

  let rowOffset = 0;
  const first = applyClaimRowUpdateToWorksheet(worksheet, {
    index: 0,
    update: {
      BotClaimDetails: detailsText([
        { dos: "02/05/2026", received: "02/06/2026", check: "111", amount: "$10.00" },
        { dos: "02/05/2026", received: "02/07/2026", check: "222", amount: "$20.00" },
      ]),
      BotClaimStatusCheck: "Success",
      BotClaimStatusCheckError: "",
    },
  }, { rowOffset });
  rowOffset += first.insertedRowCount;

  applyClaimRowUpdateToWorksheet(worksheet, {
    index: 1,
    update: {
      BotClaimDetails: detailsText([
        { dos: "02/08/2026", received: "02/09/2026", check: "333", amount: "$30.00" },
      ]),
      BotClaimStatusCheck: "Success",
      BotClaimStatusCheckError: "",
    },
  }, { rowOffset });

  const headers = headerMap(worksheet);

  assert.equal(worksheet.getRow(2).getCell(headers["Member Policy ID"]).value, "member-a");
  assert.equal(worksheet.getRow(3).getCell(headers["Member Policy ID"]).value, "member-a");
  assert.equal(worksheet.getRow(4).getCell(headers["Member Policy ID"]).value, "member-b");
  assert.equal(worksheet.getRow(4).getCell(headers["Check Number"]).value, "[333]");
});
