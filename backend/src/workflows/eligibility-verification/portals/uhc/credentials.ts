import ExcelJS from "exceljs";
import { credentialProjectMatches, type EligibilityProjectId } from "../../projects";

export type UhcEligibilityCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  totpSecret: string;
};

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "object" && "text" in value) {
    return String((value as { text?: unknown }).text ?? "").trim();
  }
  return String(value).trim();
}

function normalize(value: unknown): string {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function findValue(row: Record<string, string>, aliases: string[]): string {
  const wanted = new Set(aliases.map(normalize));
  for (const [key, value] of Object.entries(row)) {
    if (wanted.has(normalize(key)) && value) {
      return value.replace(/[​-‍﻿]/g, "").trim();
    }
  }
  return "";
}

export async function readUhcEligibilityCredentials(
  credentialFile: File,
  projectId: EligibilityProjectId = "minimax",
): Promise<UhcEligibilityCredentials> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await credentialFile.arrayBuffer());
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("UHC login workbook does not contain a worksheet.");

  const headers: string[] = [];
  worksheet.getRow(1).eachCell({ includeEmpty: false }, (cell, column) => {
    headers[column] = asText(cell.value);
  });

  for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber += 1) {
    const worksheetRow = worksheet.getRow(rowNumber);
    const row: Record<string, string> = {};
    headers.forEach((header, column) => {
      if (header) row[header] = asText(worksheetRow.getCell(column).value);
    });

    if (!credentialProjectMatches(projectId, findValue(row, ["Project"]))) continue;
    if (normalize(findValue(row, ["Portal"])) !== "uhc") continue;

    const rawLoginUrl = findValue(row, ["Link", "URL", "Login URL", "Portal Link"]);
    const username = findValue(row, ["Username", "User Name", "User ID"]);
    const password = findValue(row, ["Password"]);
    const totpSecret = findValue(row, ["Secret Key", "Secret", "TOTP Secret", "TOTP_SECRET"]);

    if (!rawLoginUrl || !username || !password || !totpSecret) {
      throw new Error(
        `The selected-project UHC credential row ${rowNumber} must include Link, Username, Password, and Secret Key.`,
      );
    }

    return {
      loginUrl: rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`,
      username,
      password,
      totpSecret,
    };
  }

  throw new Error(
    `Missing ${projectId === "minimax" ? "Minimax/TPM" : "MedRevenue"} UHC login details. The credential workbook Project column must match the selected project.`,
  );
}
