import type ExcelJS from "exceljs";

type ClaimUpdate = {
  BotClaimDetails?: string;
  BotClaimStatusCheck?: string;
  BotClaimStatusCheckError?: string;
};

export type ClaimRowUpdateEvent = {
  index: number;
  update: ClaimUpdate;
};

export type ApplyClaimRowUpdateOptions = {
  rowOffset?: number;
};

export type ApplyClaimRowUpdateResult = {
  insertedRowCount: number;
};

export type ParsedClaimDetailRecord = {
  SummaryBlockDOS: string;
  SummaryBlockDate: string;
  CheckNumber: string;
  ReceivedDate: string;
  CheckDate: string;
  CheckAmount: string;
  OtherDetails: string;
};

const BOT_HEADERS = new Set(["BotClaimDetails", "BotClaimStatusCheck", "BotClaimStatusCheckError"]);

const TARGET_COLS: Array<{ label: string; key: keyof ParsedClaimDetailRecord }> = [
  { label: "SummaryBlockDOS", key: "SummaryBlockDOS" },
  { label: "SummaryBlockDate", key: "SummaryBlockDate" },
  { label: "Check Number", key: "CheckNumber" },
  { label: "Received Date", key: "ReceivedDate" },
  { label: "Check Date", key: "CheckDate" },
  { label: "Check Amount", key: "CheckAmount" },
  { label: "Other related payment details", key: "OtherDetails" },
];

function cloneStyle(style: Partial<ExcelJS.Style> | undefined): ExcelJS.Style {
  return JSON.parse(JSON.stringify(style ?? {}));
}

function getBracketedSection(block: string, label: string): string {
  const start = block.indexOf(`${label}: [`);
  if (start === -1) return "";

  let cursor = start + label.length + 3;
  let depth = 1;
  const chars: string[] = [];

  while (cursor < block.length) {
    const char = block[cursor];
    if (char === "[") {
      depth++;
      chars.push(char);
    } else if (char === "]") {
      depth--;
      if (depth === 0) {
        return chars.join("");
      }
      chars.push(char);
    } else {
      chars.push(char);
    }
    cursor++;
  }

  return "";
}

export function parseBotClaimDetails(text: string): ParsedClaimDetailRecord[] {
  if (!text) return [];

  const blocks = text.split(/(?=Summary: \[)/).filter(Boolean);
  return blocks.map((block) => {
    const summaryText = getBracketedSection(block, "Summary");
    const detailsText = getBracketedSection(block, "Details");
    const statusText = getBracketedSection(block, "Status Info");
    const dateMatches = summaryText.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
    const amountMatch = summaryText.match(/\$\d+(?:,\d{3})*(?:\.\d{2})?/);
    const getDetailValue = (label: string) => {
      const regex = new RegExp(`${label}\\s*:\\s*([^\\n|]+)`);
      const match = detailsText.match(regex);
      return match ? match[1].trim() : "";
    };

    return {
      SummaryBlockDOS: dateMatches[0] || "",
      SummaryBlockDate: dateMatches[1] || "",
      CheckNumber: getDetailValue("Check #"),
      ReceivedDate: getDetailValue("Received Date"),
      CheckDate: getDetailValue("Check Date"),
      CheckAmount: amountMatch ? amountMatch[0] : "",
      OtherDetails: statusText,
    };
  });
}

function findColumns(headerRow: ExcelJS.Row) {
  let detailsCol = 0;
  let statusCol = 0;
  let errorCol = 0;
  let lastOriginalCol = 1;

  headerRow.eachCell((cell, colNum) => {
    const v = String(cell.value ?? "");
    if (v === "BotClaimDetails") detailsCol = colNum;
    else if (v === "BotClaimStatusCheck") statusCol = colNum;
    else if (v === "BotClaimStatusCheckError") errorCol = colNum;
    else if (!BOT_HEADERS.has(v)) lastOriginalCol = colNum;
  });

  return { detailsCol, statusCol, errorCol, lastOriginalCol };
}

function addHeader(headerRow: ExcelJS.Row, col: number, label: string, headerStyle: ExcelJS.Style) {
  const cell = headerRow.getCell(col);
  cell.value = label;
  cell.style = cloneStyle(headerStyle);
}

export function applyClaimRowUpdateToWorksheet(
  worksheet: ExcelJS.Worksheet,
  eventData: ClaimRowUpdateEvent,
  options: ApplyClaimRowUpdateOptions = {},
): ApplyClaimRowUpdateResult {
  const headerRow = worksheet.getRow(1);
  const columns = findColumns(headerRow);
  const headerStyle = cloneStyle(headerRow.getCell(columns.lastOriginalCol).style);
  const lastBotCol = Math.max(columns.detailsCol, columns.statusCol, columns.errorCol);
  let nextCol = (lastBotCol > 0 ? lastBotCol : columns.lastOriginalCol) + 1;

  if (columns.detailsCol === 0) {
    columns.detailsCol = nextCol++;
    addHeader(headerRow, columns.detailsCol, "BotClaimDetails", headerStyle);
  }
  if (columns.statusCol === 0) {
    columns.statusCol = nextCol++;
    addHeader(headerRow, columns.statusCol, "BotClaimStatusCheck", headerStyle);
  }
  if (columns.errorCol === 0) {
    columns.errorCol = nextCol++;
    addHeader(headerRow, columns.errorCol, "BotClaimStatusCheckError", headerStyle);
  }
  headerRow.commit();

  const colMap: Record<keyof ParsedClaimDetailRecord, number> = {
    SummaryBlockDOS: 0,
    SummaryBlockDate: 0,
    CheckNumber: 0,
    ReceivedDate: 0,
    CheckDate: 0,
    CheckAmount: 0,
    OtherDetails: 0,
  };

  let currentNextCol = nextCol;
  TARGET_COLS.forEach((col) => {
    let existingCol = 0;
    headerRow.eachCell((cell, colNum) => {
      if (String(cell.value) === col.label) existingCol = colNum;
    });

    if (existingCol === 0) {
      while (true) {
        let occupied = false;
        headerRow.eachCell((cell, colNum) => {
          if (colNum === currentNextCol && String(cell.value).trim() !== "") {
            occupied = true;
          }
        });
        if (!occupied) break;
        currentNextCol++;
      }
      existingCol = currentNextCol++;
      addHeader(headerRow, existingCol, col.label, headerStyle);
    } else if (currentNextCol <= existingCol) {
      currentNextCol = existingCol + 1;
    }

    colMap[col.key] = existingCol;
  });
  headerRow.commit();

  const parsedRecords = parseBotClaimDetails(eventData.update.BotClaimDetails || "");
  const recordsToWrite = parsedRecords.length > 0 ? parsedRecords : [null];
  const originalRowIndex = eventData.index + 2 + (options.rowOffset ?? 0);
  const originalRow = worksheet.getRow(originalRowIndex);

  [...recordsToWrite].reverse().forEach((record, reverseIdx) => {
    const idx = recordsToWrite.length - 1 - reverseIdx;
    const targetRowIndex = originalRowIndex + idx;
    const targetRow = idx > 0
      ? worksheet.insertRow(targetRowIndex, originalRow.values)
      : worksheet.getRow(targetRowIndex);
    const dataStyle = cloneStyle(targetRow.getCell(columns.lastOriginalCol).style);

    const setDataCell = (col: number, value: string | undefined) => {
      if (value === undefined) return;
      const cell = targetRow.getCell(col);
      cell.value = value;
      cell.style = cloneStyle(dataStyle);
    };

    setDataCell(columns.detailsCol, eventData.update.BotClaimDetails);
    setDataCell(columns.statusCol, eventData.update.BotClaimStatusCheck);
    setDataCell(columns.errorCol, eventData.update.BotClaimStatusCheckError);

    if (record) {
      Object.entries(record).forEach(([key, value]) => {
        const colNum = colMap[key as keyof ParsedClaimDetailRecord];
        if (colNum) {
          const cell = targetRow.getCell(colNum);
          cell.value = value;
          cell.style = cloneStyle(dataStyle);
        }
      });
    }

    targetRow.commit();
  });

  return { insertedRowCount: Math.max(recordsToWrite.length - 1, 0) };
}
