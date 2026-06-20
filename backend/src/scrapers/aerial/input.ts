import fs from "node:fs/promises";
import path from "node:path";
import * as XLSX from "xlsx";
import { loadAerialEnvironment } from "./env";

export type AerialCredentials = {
  loginUrl: string;
  username: string;
  password: string;
  successUrlFragment?: string;
  claimsUrl: string;
};

export type AerialInput = {
  credentials: AerialCredentials;
  inputWorkbookBuffer: ArrayBuffer;
  inputFileName: string;
};

function asText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function optionalEnv(name: string): string {
  return asText(process.env[name]);
}

function normalizeLoginUrl(rawLoginUrl: string): string {
  return rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`;
}

function loadAerialCredentialsFromEnv(): AerialCredentials | null {
  loadAerialEnvironment();
  const rawLoginUrl = optionalEnv("PORTAL_AERIAL_LOGIN_URL");
  const username = optionalEnv("PORTAL_AERIAL_USERNAME");
  const password = optionalEnv("PORTAL_AERIAL_PASSWORD");

  if (!rawLoginUrl || !username || !password) {
    return null;
  }

  return {
    loginUrl: normalizeLoginUrl(rawLoginUrl),
    username,
    password,
    claimsUrl: optionalEnv("PORTAL_AERIAL_CLAIMS_URL"),
    successUrlFragment: optionalEnv("PORTAL_AERIAL_SUCCESS_URL_FRAGMENT"),
  };
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const normalizedAliases = aliases.map((alias) => alias.trim().toLowerCase());
  for (const [key, value] of Object.entries(row)) {
    if (normalizedAliases.includes(key.trim().toLowerCase())) {
      const text = asText(value);
      if (text) return text;
    }
  }
  return "";
}

function loadAerialCredentialsFromWorkbook(buffer: ArrayBuffer): AerialCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
  for (const row of rows) {
    const rawLoginUrl = findValue(row, ["URL", "Login URL", "Aerial URL", "PORTAL_AERIAL_LOGIN_URL"]);
    const username = findValue(row, ["User Name", "Username", "PORTAL_AERIAL_USERNAME"]);
    const password = findValue(row, ["Password", "PORTAL_AERIAL_PASSWORD"]);

    if (rawLoginUrl && username && password) {
      return {
        loginUrl: normalizeLoginUrl(rawLoginUrl),
        username,
        password,
        claimsUrl: findValue(row, ["Claims URL", "PORTAL_AERIAL_CLAIMS_URL"]),
        successUrlFragment: findValue(row, ["Success URL Fragment", "PORTAL_AERIAL_SUCCESS_URL_FRAGMENT"]),
      };
    }
  }

  return null;
}

async function loadOptionalWorkbookBuffer(file: FormDataEntryValue | null): Promise<ArrayBuffer | null> {
  return file instanceof File ? file.arrayBuffer() : null;
}

function resolveAerialCredentials(inputWorkbookBuffer: ArrayBuffer, credentialWorkbookBuffer: ArrayBuffer | null): AerialCredentials {
  const envCredentials = loadAerialCredentialsFromEnv();
  if (envCredentials) return envCredentials;

  if (credentialWorkbookBuffer) {
    const credentialWorkbookCredentials = loadAerialCredentialsFromWorkbook(credentialWorkbookBuffer);
    if (credentialWorkbookCredentials) return credentialWorkbookCredentials;
  }

  const workbookCredentials = loadAerialCredentialsFromWorkbook(inputWorkbookBuffer);
  if (workbookCredentials) return workbookCredentials;

  throw new Error(
    "Missing Aerial credentials. Provide env credentials, upload an Aerial login Excel, or include URL/Login URL, User Name/Username, and Password columns in the uploaded Aerial claim workbook.",
  );
}

function bufferToArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
}

async function loadInputWorkbookBuffer(inputExcel: FormDataEntryValue | null): Promise<{ buffer: ArrayBuffer; fileName: string }> {
  if (inputExcel instanceof File) {
    return {
      buffer: await inputExcel.arrayBuffer(),
      fileName: inputExcel.name || "aerial_input.xlsx",
    };
  }

  const inputPath = optionalEnv("PORTAL_AERIAL_INPUT_XLSX_PATH");
  if (!inputPath) {
    throw new Error("Missing Aerial input Excel file. Upload a file or set PORTAL_AERIAL_INPUT_XLSX_PATH in the Aerial env file.");
  }

  const fileBuffer = await fs.readFile(inputPath);
  return {
    buffer: bufferToArrayBuffer(fileBuffer),
    fileName: path.basename(inputPath),
  };
}

export async function parseAerialInput(formData: FormData): Promise<AerialInput> {
  loadAerialEnvironment();
  const credentialExcel = formData.get("credentialExcel");
  const inputExcel = formData.get("inputExcel");
  const credentialWorkbookBuffer = await loadOptionalWorkbookBuffer(credentialExcel);
  const inputWorkbook = await loadInputWorkbookBuffer(inputExcel);

  return {
    credentials: resolveAerialCredentials(inputWorkbook.buffer, credentialWorkbookBuffer),
    inputWorkbookBuffer: inputWorkbook.buffer,
    inputFileName: inputWorkbook.fileName,
  };
}
