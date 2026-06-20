import fs from "node:fs/promises";
import path from "node:path";
import { loadAerialEnvironment } from "./env";
import { aerialConfig } from "./config";

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

function requiredEnv(name: string): string {
  const value = asText(process.env[name]);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string {
  return asText(process.env[name]);
}

function loadAerialCredentialsFromEnv(): AerialCredentials {
  loadAerialEnvironment();
  const rawLoginUrl = requiredEnv("PORTAL_AERIAL_LOGIN_URL");
  return {
    loginUrl: rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`,
    username: requiredEnv("PORTAL_AERIAL_USERNAME"),
    password: requiredEnv("PORTAL_AERIAL_PASSWORD"),
    claimsUrl: optionalEnv("PORTAL_AERIAL_CLAIMS_URL"),
    successUrlFragment: optionalEnv("PORTAL_AERIAL_SUCCESS_URL_FRAGMENT"),
  };
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
  const inputExcel = formData.get("inputExcel");
  const inputWorkbook = await loadInputWorkbookBuffer(inputExcel);

  return {
    credentials: loadAerialCredentialsFromEnv(),
    inputWorkbookBuffer: inputWorkbook.buffer,
    inputFileName: inputWorkbook.fileName,
  };
}
