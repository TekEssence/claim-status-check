import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { applyClaimRowUpdateToWorksheet, parseBotClaimDetails, postProcessWorksheet } from "../lib/claim-workbook";

function headerMap(worksheet: ExcelJS.Worksheet) {
  const headers: Record<string, number> = {};
  worksheet.getRow(1).eachCell((cell, colNum) => {
    headers[String(cell.value)] = colNum;
  });
  return headers;
}

function detailsText(
  records: Array<{ dos: string; received: string; check: string; amount: string; cin?: string; plan?: string }>
) {
  return records.map((record) => {
    let details = `Check #: [${record.check}]\nReceived Date: ${record.received}\nCheck Date: ${record.received}`;
    if (record.cin) details += `\nCIN: ${record.cin}`;
    if (record.plan) details += `\nPlan Type: ${record.plan}`;
    
    return `Summary: [${record.dos} ${record.received} ${record.amount}] | Details: [${details}] | Status Info: [Paid in full]`;
  }).join(" | ");
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
    BotCIN: "",
    BotPlanType: "",
  });
});

test("parses CIN and Plan Type correctly", () => {
  const [record] = parseBotClaimDetails(detailsText([
    { dos: "02/05/2026", received: "02/06/2026", check: "12345", amount: "$42.50", cin: "98765432B", plan: "Medi-Cal" },
  ]));

  assert.equal(record.BotCIN, "98765432B");
  assert.equal(record.BotPlanType, "Medi-Cal");
});

test("writes Bot CIN and Bot Plan Type columns correctly", () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Member Policy ID", "Date Of Service"]);
  worksheet.addRow(["member-a", "02/05/2026"]);

  // Phase 1: 1-to-1 Update
  applyClaimRowUpdateToWorksheet(worksheet, {
    index: 0,
    update: {
      BotClaimDetails: detailsText([
        { dos: "02/05/2026", received: "02/06/2026", check: "111", amount: "$10.00", cin: "12345678A", plan: "IEHP Medi-Cal" },
      ]),
      BotClaimStatusCheck: "Success",
      BotClaimStatusCheckError: "",
    },
  });

  // Phase 2: Post-Processing
  postProcessWorksheet(worksheet);

  const headers = headerMap(worksheet);
  assert.ok(headers["Bot CIN"]);
  assert.ok(headers["Bot Plan Type"]);

  // Verify the exact column ordering requested:
  // - Bot CIN should be after Check Number
  // - Bot Plan Type should be after Check Date
  assert.equal(headers["Bot CIN"], headers["Check Number"] + 1);
  assert.equal(headers["Bot Plan Type"], headers["Check Date"] + 1);

  const dataRow = worksheet.getRow(2);
  assert.equal(dataRow.getCell(headers["Bot CIN"]).value, "12345678A");
  assert.equal(dataRow.getCell(headers["Bot Plan Type"]).value, "IEHP Medi-Cal");
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

  // Phase 1: 1-to-1 update
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

  // Phase 2: Post-processing
  postProcessWorksheet(worksheet);

  const headers = headerMap(worksheet);

  assert.equal(headers["Manual Review"], 7);
  assert.equal(headers["BotUpdateTime"], 8);
  assert.equal(worksheet.getRow(2).getCell(headers["BotClaimStatusCheck"]).value, "Success");
  assert.equal(worksheet.getRow(3).getCell(headers["BotClaimStatusCheck"]).value, "Success");
  assert.equal(worksheet.getRow(2).getCell(headers["SummaryBlockDOS"]).value, "02/05/2026");
  assert.equal(worksheet.getRow(3).getCell(headers["Check Number"]).value, "[222]");
  assert.equal(worksheet.getRow(2).getCell(headers["Check Amount"]).value, 10);
  assert.equal(worksheet.getRow(3).getCell(headers["Check Amount"]).value, 20);
  assert.equal(worksheet.getRow(2).getCell(headers["Manual Review"]).value, "manual-a");
  assert.equal(worksheet.getRow(3).getCell(headers["Manual Review"]).value, "manual-a");
  assert.equal(worksheet.getRow(4).getCell(headers["Member Policy ID"]).value, "member-b");
  assert.equal(worksheet.getRow(4).getCell(headers["Manual Review"]).value, "manual-b");

  assert.match(String(worksheet.getRow(2).getCell(headers["BotUpdateTime"]).value), /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
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

  // Even after post-processing, no details should be written and no rows duplicated
  postProcessWorksheet(worksheet);

  const headers = headerMap(worksheet);

  assert.equal(worksheet.getRow(2).getCell(headers["BotClaimStatusCheck"]).value, "Skipped");
  assert.equal(
    worksheet.getRow(2).getCell(headers["BotClaimStatusCheckError"]).value,
    "Skipped: Invalid Date of Service format: bad-date",
  );
});

test("guarantees 1-to-1 batch phase updates before post-processing duplication", () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  worksheet.addRow(["Member Policy ID", "Date Of Service"]);
  worksheet.addRow(["member-a", "02/05/2026"]);
  worksheet.addRow(["member-b", "02/08/2026"]);

  // During batch phase, no row shifting occurs:
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

  applyClaimRowUpdateToWorksheet(worksheet, {
    index: 1,
    update: {
      BotClaimDetails: detailsText([
        { dos: "02/08/2026", received: "02/09/2026", check: "333", amount: "$30.00" },
      ]),
      BotClaimStatusCheck: "Success",
      BotClaimStatusCheckError: "",
    },
  });

  // Verify that during batching, row 2 is member-a and row 3 is member-b (no shifts yet!)
  const headersBatch = headerMap(worksheet);
  assert.equal(worksheet.getRow(2).getCell(headersBatch["BotClaimStatusCheck"]).value, "Success");
  assert.equal(worksheet.getRow(3).getCell(headersBatch["BotClaimStatusCheck"]).value, "Success");
  assert.equal(worksheet.actualRowCount, 3); // 1 header row + 2 data rows

  // Perform post-processing
  postProcessWorksheet(worksheet);

  const headers = headerMap(worksheet);

  // Now, row 2 and 3 should be member-a (duplicated), and row 4 should be member-b
  assert.equal(worksheet.getRow(2).getCell(headers["Member Policy ID"]).value, "member-a");
  assert.equal(worksheet.getRow(3).getCell(headers["Member Policy ID"]).value, "member-a");
  assert.equal(worksheet.getRow(4).getCell(headers["Member Policy ID"]).value, "member-b");
  assert.equal(worksheet.getRow(4).getCell(headers["Check Number"]).value, "[333]");
  assert.equal(worksheet.actualRowCount, 4); // 1 header row + 3 data rows
});

test("parses space-separated detail blocks correctly (regex lookahead check)", () => {
  const blobText = "Summary: [02/05/2026 02/06/2026 $42.50] | Details: [Check #: 12345 Received Date: 02/06/2026 Check Date: 02/06/2026] | Status Info: [Paid in full]";
  const [record] = parseBotClaimDetails(blobText);

  assert.deepEqual(record, {
    SummaryBlockDOS: "02/05/2026",
    SummaryBlockDate: "02/06/2026",
    CheckNumber: "12345",
    ReceivedDate: "02/06/2026",
    CheckDate: "02/06/2026",
    CheckAmount: "$42.50",
    OtherDetails: "Paid in full",
    BotCIN: "",
    BotPlanType: "",
  });
});

test("preserves styles on new columns and inserted rows cell-by-cell during post-processing", () => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet("Claims");
  
  // Setup styled headers and rows
  const headerRow = worksheet.addRow(["Member Policy ID", "Date Of Service"]);
  headerRow.getCell(1).style = { font: { bold: true, color: { argb: "FFFF0000" } } };
  headerRow.getCell(2).style = { font: { bold: true, color: { argb: "FFFF0000" } } };

  const dataRow = worksheet.addRow(["member-a", "02/05/2026"]);
  dataRow.getCell(1).style = { fill: { type: "solid", fgColor: { argb: "FFFFE0E0" } } };
  dataRow.getCell(2).style = { fill: { type: "solid", fgColor: { argb: "FFFFE0E0" } } };

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

  postProcessWorksheet(worksheet);

  const headers = headerMap(worksheet);

  // Assert that newly created headers inherited original header style
  assert.equal(worksheet.getRow(1).getCell(headers["BotUpdateTime"]).style.font?.bold, true);
  assert.equal(worksheet.getRow(1).getCell(headers["BotUpdateTime"]).style.font?.color?.argb, "FFFF0000");

  // Assert that both the original row and the inserted row inherited data row styling
  const row2 = worksheet.getRow(2); // Original row
  const row3 = worksheet.getRow(3); // Inserted row

  assert.equal(row2.getCell(headers["Member Policy ID"]).style.fill?.type, "solid");
  assert.equal(row2.getCell(headers["Member Policy ID"]).style.fill?.fgColor?.argb, "FFFFE0E0");

  assert.equal(row3.getCell(headers["Member Policy ID"]).style.fill?.type, "solid");
  assert.equal(row3.getCell(headers["Member Policy ID"]).style.fill?.fgColor?.argb, "FFFFE0E0");
  
  // Assert newly created columns also got the styled details
  assert.equal(row2.getCell(headers["Check Number"]).style.fill?.fgColor?.argb, "FFFFE0E0");
  assert.equal(row3.getCell(headers["Check Number"]).style.fill?.fgColor?.argb, "FFFFE0E0");
});
