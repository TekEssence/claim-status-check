import ExcelJS from "exceljs";
import * as XLSX from "xlsx";
import type { FileSystemFileHandle, WindowWithFilePicker } from "../../../types/file-system-access";
import type { ClaimRow } from "../../../types/job";
import { parseUhcClaimRows } from "../portals/uhc/workbook";
import { postProcessWorksheet } from "../portals/iehp/workbook";
import { getErrorMessage } from "./artifacts";

export type IehpWorkbookBundle = {
  claimRows: ClaimRow[];
  totalRows: number;
  excelWb: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
};

export type UhcWorkbookBundle = {
  claimRows: ReturnType<typeof parseUhcClaimRows>;
  totalRows: number;
  excelWb: ExcelJS.Workbook;
  worksheet: ExcelJS.Worksheet;
};

export function isMissingLocalFileError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("notfounderror") ||
    message.includes("the requested file could not be found") ||
    message.includes("could not find the file") ||
    message.includes("file or directory could not be found") ||
    message.includes("not be found")
  );
}

export function isFileAccessPermissionError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return (
    message.includes("notallowederror") ||
    message.includes("securityerror") ||
    message.includes("request is not allowed by the user agent or the platform in the current context") ||
    message.includes("permission") ||
    message.includes("user activation")
  );
}

export function getMissingLocalExcelMessage(fileName: string): string {
  return `The previously selected Excel file${fileName ? ` (${fileName})` : ""} was not found on this computer. Please reselect the same claim file and continue.`;
}

export function getExcelReauthorizeMessage(fileName: string): string {
  return `Please click Allow And Continue to allow access to the same claim Excel${fileName ? ` (${fileName})` : ""} and continue the previous IEHP run.`;
}

export async function selectExcelFileHandle(): Promise<FileSystemFileHandle | null> {
  const picker = (window as WindowWithFilePicker).showOpenFilePicker;
  if (!picker) {
    throw new Error("Your browser does not support direct file updates. Use Chrome or Edge.");
  }

  const [fileHandle] = await picker({
    types: [
      {
        description: "Excel Files",
        accept: {
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
          "application/vnd.ms-excel": [".xls"],
        },
      },
    ],
    excludeAcceptAllOption: true,
    multiple: false,
  });

  return fileHandle ?? null;
}

export async function loadIehpWorkbookBundle(
  claimFileHandle: FileSystemFileHandle,
  options: { requestPermission?: boolean; fileNameForErrors?: string } = {},
): Promise<IehpWorkbookBundle> {
  const fileNameForErrors = options.fileNameForErrors ?? "";
  const currentPermission = await claimFileHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const);
  if (currentPermission !== "granted") {
    if (!options.requestPermission) {
      throw new Error(getExcelReauthorizeMessage(fileNameForErrors));
    }
    if ((await claimFileHandle.requestPermission({ mode: "readwrite" }).catch(() => "denied" as const)) !== "granted") {
      throw new Error("Write permission denied. Cannot update Excel file.");
    }
  }

  let file: File;
  try {
    file = await claimFileHandle.getFile();
  } catch (error) {
    if (isMissingLocalFileError(error)) {
      throw new Error(getMissingLocalExcelMessage(fileNameForErrors));
    }
    if (isFileAccessPermissionError(error)) {
      throw new Error(getExcelReauthorizeMessage(fileNameForErrors));
    }
    throw error;
  }
  const arrayBuffer = await file.arrayBuffer();
  const xlsxWb = XLSX.read(arrayBuffer, { type: "array", cellDates: false });
  const sheetName = xlsxWb.SheetNames[0];
  const rawClaimRows = XLSX.utils.sheet_to_json(xlsxWb.Sheets[sheetName]) as Record<string, unknown>[];
  const claimRows: ClaimRow[] = rawClaimRows.map((row, idx) => ({ ...row, __original_index: idx }));

  if (claimRows.length === 0) {
    throw new Error("Claim Excel file contains no rows to process.");
  }

  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(arrayBuffer);
  const worksheet = excelWb.worksheets[0];
  if (!worksheet) {
    throw new Error("Claim Excel file does not contain a worksheet.");
  }

  return {
    claimRows,
    totalRows: claimRows.length,
    excelWb,
    worksheet,
  };
}

export async function loadUhcWorkbookBundle(claimFileHandle: FileSystemFileHandle, groupId: string): Promise<UhcWorkbookBundle> {
  const currentPermission = await claimFileHandle.queryPermission({ mode: "readwrite" }).catch(() => "prompt" as const);
  if (currentPermission !== "granted") {
    if ((await claimFileHandle.requestPermission({ mode: "readwrite" }).catch(() => "denied" as const)) !== "granted") {
      throw new Error("Write permission denied. Cannot update UHC Excel file.");
    }
  }

  const file = await claimFileHandle.getFile();
  const arrayBuffer = await file.arrayBuffer();
  const excelWb = new ExcelJS.Workbook();
  await excelWb.xlsx.load(arrayBuffer);
  const worksheet = excelWb.worksheets[0];
  if (!worksheet) {
    throw new Error("UHC claim Excel file does not contain a worksheet.");
  }

  const claimRows = parseUhcClaimRows(worksheet, {
    requirePatientDob: groupId !== "medrevenu",
  });
  if (claimRows.length === 0) {
    throw new Error("UHC claim Excel file contains no rows to process.");
  }

  return {
    claimRows,
    totalRows: claimRows.length,
    excelWb,
    worksheet,
  };
}

export async function writeWorkbookToClaimFile(claimFileHandle: FileSystemFileHandle, excelWb: ExcelJS.Workbook): Promise<void> {
  const permission = await claimFileHandle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    const requestedPermission = await claimFileHandle.requestPermission({ mode: "readwrite" });
    if (requestedPermission !== "granted") {
      throw new Error("Browser write permission was denied. Please allow file access and run again.");
    }
  }

  const updatedBuffer = await excelWb.xlsx.writeBuffer();
  const writable = await claimFileHandle.createWritable();
  await writable.write(updatedBuffer);
  await writable.close();
}

export async function cloneWorkbook(excelWb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buffer = await excelWb.xlsx.writeBuffer();
  const clonedWb = new ExcelJS.Workbook();
  await clonedWb.xlsx.load(buffer);
  return clonedWb;
}

export async function writeIehpPostProcessedCheckpoint(
  claimFileHandle: FileSystemFileHandle,
  excelWb: ExcelJS.Workbook,
): Promise<void> {
  const checkpointWb = await cloneWorkbook(excelWb);
  const checkpointWorksheet = checkpointWb.getWorksheet(1);
  if (!checkpointWorksheet) {
    throw new Error("Claim Excel file does not contain a worksheet.");
  }
  postProcessWorksheet(checkpointWorksheet);
  await writeWorkbookToClaimFile(claimFileHandle, checkpointWb);
}

