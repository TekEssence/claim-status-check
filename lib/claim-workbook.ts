import type ExcelJS from "exceljs";
import { parseDateInput } from "./claim-dates";

type ClaimUpdate = {
  BotClaimDetails?: string;
  BotClaimStatusCheck?: string;
  BotClaimStatusCheckError?: string;
  BotReferRA?: string;
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
  BotCIN: string;
  BotPlanType: string;
};

const BOT_HEADERS = new Set([
  "BotClaimDetails",
  "BotClaimStatusCheck",
  "BotClaimStatusCheckError",
  "BotUpdateTime",
  "BotReferRA",
  "SummaryBlockDOS",
  "SummaryBlockDate",
  "Check Number",
  "Received Date",
  "Check Date",
  "Check Amount",
  "Other related payment details",
  "Bot CIN",
  "Bot Plan Type",
]);

const TARGET_COLS: Array<{ label: string; key: keyof ParsedClaimDetailRecord }> = [
  { label: "SummaryBlockDOS", key: "SummaryBlockDOS" },
  { label: "SummaryBlockDate", key: "SummaryBlockDate" },
  { label: "Check Number", key: "CheckNumber" },
  { label: "Bot CIN", key: "BotCIN" },
  { label: "Received Date", key: "ReceivedDate" },
  { label: "Check Date", key: "CheckDate" },
  { label: "Bot Plan Type", key: "BotPlanType" },
  { label: "Check Amount", key: "CheckAmount" },
  { label: "Other related payment details", key: "OtherDetails" },
];

function cloneStyle(style: Partial<ExcelJS.Style> | undefined): ExcelJS.Style {
  if (!style) return {} as ExcelJS.Style;
  const cloned: Partial<ExcelJS.Style> = {};
  if (style.numFmt !== undefined) cloned.numFmt = style.numFmt;
  if (style.font) cloned.font = JSON.parse(JSON.stringify(style.font));
  if (style.fill) cloned.fill = JSON.parse(JSON.stringify(style.fill));
  if (style.border) cloned.border = JSON.parse(JSON.stringify(style.border));
  if (style.alignment) cloned.alignment = JSON.parse(JSON.stringify(style.alignment));
  if (style.protection) cloned.protection = JSON.parse(JSON.stringify(style.protection));
  return cloned as ExcelJS.Style;
}

function getFormattedTimestamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const month = pad(now.getMonth() + 1);
  const day = pad(now.getDate());
  const year = now.getFullYear();
  const hours = pad(now.getHours());
  const minutes = pad(now.getMinutes());
  const seconds = pad(now.getSeconds());
  return `${month}/${day}/${year} ${hours}:${minutes}:${seconds}`;
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
      const escapedLabel = label.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&");
      const regex = new RegExp(
        `${escapedLabel}\\s*:\\s*([^|\\n]+?)(?=\\s*(?:Check\\s*#|Received\\s*Date|Check\\s*Date|Patient\\s*Name|Claim\\s*#|Status|Summary|Details|Status\\s*Info|CIN|Plan\\s*Type)\\s*:|$)`,
        "i"
      );
      const match = detailsText.match(regex);
      return match ? match[1].trim() : "";
    };

    const botCin = getDetailValue("CIN");
    const botPlanType = getDetailValue("Plan Type");

    return {
      SummaryBlockDOS: dateMatches[0] || "",
      SummaryBlockDate: dateMatches[1] || "",
      CheckNumber: getDetailValue("Check #"),
      ReceivedDate: getDetailValue("Received Date"),
      CheckDate: getDetailValue("Check Date"),
      CheckAmount: amountMatch ? amountMatch[0] : "",
      OtherDetails: statusText,
      BotCIN: botCin,
      BotPlanType: botPlanType,
    };
  });
}

function findColumns(headerRow: ExcelJS.Row) {
  let detailsCol = 0;
  let statusCol = 0;
  let errorCol = 0;
  let updateTimeCol = 0;
  let referRaCol = 0;
  let lastOriginalCol = 1;

  headerRow.eachCell((cell, colNum) => {
    const v = String(cell.value ?? "");
    if (v === "BotClaimDetails") detailsCol = colNum;
    else if (v === "BotClaimStatusCheck") statusCol = colNum;
    else if (v === "BotClaimStatusCheckError") errorCol = colNum;
    else if (v === "BotUpdateTime") updateTimeCol = colNum;
    else if (v === "BotReferRA") referRaCol = colNum;
    else if (!BOT_HEADERS.has(v)) lastOriginalCol = colNum;
  });

  return { detailsCol, statusCol, errorCol, updateTimeCol, referRaCol, lastOriginalCol };
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
  const lastBotCol = Math.max(
    columns.detailsCol,
    columns.statusCol,
    columns.errorCol,
    columns.updateTimeCol,
    columns.referRaCol
  );
  let nextCol = (lastBotCol > 0 ? lastBotCol : columns.lastOriginalCol) + 1;

  const getNextAvailableCol = (start: number): number => {
    let col = start;
    while (true) {
      const cellValue = String(headerRow.getCell(col).value ?? "").trim();
      if (cellValue === "") {
        return col;
      }
      col++;
    }
  };

  if (columns.detailsCol === 0) {
    nextCol = getNextAvailableCol(nextCol);
    columns.detailsCol = nextCol++;
    addHeader(headerRow, columns.detailsCol, "BotClaimDetails", headerStyle);
  }
  if (columns.statusCol === 0) {
    nextCol = getNextAvailableCol(nextCol);
    columns.statusCol = nextCol++;
    addHeader(headerRow, columns.statusCol, "BotClaimStatusCheck", headerStyle);
  }
  if (columns.errorCol === 0) {
    nextCol = getNextAvailableCol(nextCol);
    columns.errorCol = nextCol++;
    addHeader(headerRow, columns.errorCol, "BotClaimStatusCheckError", headerStyle);
  }
  if (columns.updateTimeCol === 0) {
    nextCol = getNextAvailableCol(nextCol);
    columns.updateTimeCol = nextCol++;
    addHeader(headerRow, columns.updateTimeCol, "BotUpdateTime", headerStyle);
  }
  if (columns.referRaCol === 0) {
    nextCol = getNextAvailableCol(nextCol);
    columns.referRaCol = nextCol++;
    addHeader(headerRow, columns.referRaCol, "BotReferRA", headerStyle);
  }
  headerRow.commit();

  const targetRowIndex = eventData.index + 2;
  const targetRow = worksheet.getRow(targetRowIndex);

  const dataStyle = cloneStyle(targetRow.getCell(columns.lastOriginalCol).style);
  delete (dataStyle as any).numFmt;

  const setDataCell = (col: number, value: string | undefined) => {
    if (value === undefined) return;
    const cell = targetRow.getCell(col);
    cell.value = value;
    cell.style = cloneStyle(dataStyle);
  };

  setDataCell(columns.detailsCol, eventData.update.BotClaimDetails);
  setDataCell(columns.statusCol, eventData.update.BotClaimStatusCheck);
  setDataCell(columns.errorCol, eventData.update.BotClaimStatusCheckError);
  setDataCell(columns.updateTimeCol, getFormattedTimestamp());
  setDataCell(columns.referRaCol, eventData.update.BotReferRA);

  targetRow.commit();

  return { insertedRowCount: 0 };
}

export function postProcessWorksheet(worksheet: ExcelJS.Worksheet): void {
  const headerRow = worksheet.getRow(1);
  const columns = findColumns(headerRow);
  const headerStyle = cloneStyle(headerRow.getCell(columns.lastOriginalCol).style);

  const lastBotCol = Math.max(
    columns.detailsCol,
    columns.statusCol,
    columns.errorCol,
    columns.updateTimeCol
  );
  let nextCol = (lastBotCol > 0 ? lastBotCol : columns.lastOriginalCol) + 1;

  const getNextAvailableCol = (start: number): number => {
    let col = start;
    while (true) {
      const cellValue = String(headerRow.getCell(col).value ?? "").trim();
      if (cellValue === "") {
        return col;
      }
      col++;
    }
  };

  const colMap: Record<keyof ParsedClaimDetailRecord, number> = {
    SummaryBlockDOS: 0,
    SummaryBlockDate: 0,
    CheckNumber: 0,
    ReceivedDate: 0,
    CheckDate: 0,
    CheckAmount: 0,
    OtherDetails: 0,
    BotCIN: 0,
    BotPlanType: 0,
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

  let r = 2;
  while (r <= worksheet.actualRowCount) {
    const row = worksheet.getRow(r);
    const detailsVal = columns.detailsCol > 0 ? String(row.getCell(columns.detailsCol).value ?? "").trim() : "";

    if (!detailsVal) {
      r++;
      continue;
    }

    const parsedRecords = parseBotClaimDetails(detailsVal);
    const N = parsedRecords.length;
    if (N === 0) {
      r++;
      continue;
    }

    // If N > 1, duplicate this row N - 1 times below r
    if (N > 1) {
      for (let k = 1; k < N; k++) {
        const insertAt = r + k;
        worksheet.insertRow(insertAt, row.values);

        const newRow = worksheet.getRow(insertAt);
        if (row.height !== undefined) {
          newRow.height = row.height;
        }
        const rowAny = row as any;
        const newRowAny = newRow as any;
        if (rowAny.style) {
          newRowAny.style = cloneStyle(rowAny.style);
        }
        const maxCol = Math.max(worksheet.columnCount, row.cellCount || 0);
        for (let colNum = 1; colNum <= maxCol; colNum++) {
          const cell = row.getCell(colNum);
          const targetCell = newRow.getCell(colNum);
          targetCell.style = cloneStyle(cell.style);
        }
      }
    }

    // Populate parsed records for all N rows (r to r + N - 1)
    for (let k = 0; k < N; k++) {
      const targetRow = worksheet.getRow(r + k);
      const record = parsedRecords[k];

      const dataStyle = cloneStyle(targetRow.getCell(columns.lastOriginalCol).style);
      delete (dataStyle as any).numFmt;

      const dateStyle = cloneStyle(dataStyle);
      dateStyle.numFmt = "mm-dd-yy";

      const currencyStyle = cloneStyle(dataStyle);
      currencyStyle.numFmt = "$#,##0.00";

      Object.entries(record).forEach(([key, value]) => {
        const colNum = colMap[key as keyof ParsedClaimDetailRecord];
        if (colNum) {
          const cell = targetRow.getCell(colNum);
          if (["SummaryBlockDOS", "SummaryBlockDate", "ReceivedDate", "CheckDate"].includes(key)) {
            cell.value = value;
            cell.style = cloneStyle(dateStyle);
          } else if (key === "CheckAmount") {
            if (typeof value === "string") {
              const numVal = parseFloat(value.replace(/[^0-9.-]/g, ""));
              if (!isNaN(numVal)) {
                cell.value = numVal;
              } else {
                cell.value = value;
              }
            } else {
              cell.value = value;
            }
            cell.style = cloneStyle(currencyStyle);
          } else {
            cell.value = value;
            cell.style = cloneStyle(dataStyle);
          }
        }
      });
      targetRow.commit();
    }

    r += N;
  }
}
