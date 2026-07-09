"use strict";

const path = require("path");
const ExcelJS = require("exceljs");

const DEFAULT_INPUT_FILE = "claim_status_check.xlsx";
const DEFAULT_INPUT_SHEET = "Sheet 1";
const DEFAULT_MAPPING_FILE = "Payer_mapping_ava.xlsx";

function normalizeHeader(value) {
  return String(value || "").trim();
}

function normalizeValue(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${month}/${day}/${value.getFullYear()}`;
  }
  if (typeof value === "object" && value.text) {
    return String(value.text).trim();
  }
  return String(value).trim();
}

function getWorksheet(workbook, sheetName) {
  const worksheet = workbook.getWorksheet(sheetName);
  if (!worksheet) {
    throw new Error(`Worksheet not found: ${sheetName}`);
  }
  return worksheet;
}

function getHeaders(worksheet) {
  const headerRow = worksheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cell.value);
  });
  return headers;
}

async function readInputRows(options = {}) {
  const inputPath = path.resolve(options.inputFile || DEFAULT_INPUT_FILE);
  const sheetName = options.sheetName || DEFAULT_INPUT_SHEET;
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  const worksheet = getWorksheet(workbook, sheetName);
  const headers = getHeaders(worksheet);
  const rows = [];

  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) {
      return;
    }

    const data = {};
    headers.forEach((header, colNumber) => {
      if (!header) {
        return;
      }
      data[header] = normalizeValue(row.getCell(colNumber).value);
    });

    rows.push({
      input_row_id: rowNumber - 1,
      source_row_number: rowNumber,
      data
    });
  });

  return {
    inputPath,
    sheetName,
    headers: headers.filter(Boolean),
    rows
  };
}

async function readPayerMapping(mappingFile = DEFAULT_MAPPING_FILE) {
  const mappingPath = path.resolve(mappingFile);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(mappingPath);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error(`No worksheet found in payer mapping file: ${mappingFile}`);
  }

  const headers = getHeaders(worksheet);
  const excelNameCol = headers.findIndex((header) => header === "Payer name in excel");
  const websiteNameCol = headers.findIndex((header) => header === "Payer name in website");

  if (excelNameCol < 1 || websiteNameCol < 1) {
    throw new Error("Payer mapping must contain columns: Payer name in excel, Payer name in website");
  }

  const mapping = new Map();
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) {
      return;
    }
    const excelName = normalizeValue(row.getCell(excelNameCol).value);
    const websiteName = normalizeValue(row.getCell(websiteNameCol).value);
    if (excelName && websiteName) {
      mapping.set(excelName.toLowerCase(), websiteName);
    }
  });

  return mapping;
}

module.exports = {
  DEFAULT_INPUT_FILE,
  DEFAULT_INPUT_SHEET,
  DEFAULT_MAPPING_FILE,
  normalizeValue,
  readInputRows,
  readPayerMapping
};
