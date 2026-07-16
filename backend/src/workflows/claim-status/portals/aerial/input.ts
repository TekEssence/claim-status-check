import fs from "node:fs/promises";
import path from "node:path";
import { loadAerialEnvironment } from "./env";
import { loadCredentialsForAerialSubportal } from "./common/credential-workbook";
import type { AerialCredentials, AerialSubportal } from "./common/subportal";
import { getAerialSubportal, resolveAerialSubportal } from "./subportals/registry";

export type { AerialCredentials, AerialSubportal } from "./common/subportal";

export type AerialInput = {
  subportal: AerialSubportal;
  credentials: AerialCredentials;
  inputWorkbookBuffer: ArrayBuffer;
  inputFileName: string;
};

export const AERIAL_SUBPORTAL_LABELS: Record<AerialSubportal, string> = {
  pmg: getAerialSubportal("pmg").label,
  "citrus-valley": getAerialSubportal("citrus-valley").label,
};

function asText(value: unknown): string {
  return value == null ? "" : String(value).trim();
}

function optionalEnv(name: string): string {
  return asText(process.env[name]);
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
    loginUrl: rawLoginUrl.startsWith("http") ? rawLoginUrl : `https://${rawLoginUrl}`,
    username,
    password,
    claimsUrl: optionalEnv("PORTAL_AERIAL_CLAIMS_URL"),
    successUrlFragment: optionalEnv("PORTAL_AERIAL_SUCCESS_URL_FRAGMENT"),
  };
}

export function loadAerialCredentialsFromWorkbook(buffer: ArrayBuffer, subportal: AerialSubportal): AerialCredentials | null {
  return loadCredentialsForAerialSubportal(buffer, getAerialSubportal(subportal));
}

async function loadOptionalWorkbookBuffer(file: FormDataEntryValue | null): Promise<ArrayBuffer | null> {
  return file instanceof File ? file.arrayBuffer() : null;
}

function resolveAerialCredentials(
  subportal: AerialSubportal,
  inputWorkbookBuffer: ArrayBuffer,
  credentialWorkbookBuffer: ArrayBuffer | null,
): AerialCredentials {
  const subportalDefinition = getAerialSubportal(subportal);
  if (credentialWorkbookBuffer) {
    const credentialWorkbookCredentials = loadAerialCredentialsFromWorkbook(credentialWorkbookBuffer, subportal);
    if (credentialWorkbookCredentials) return credentialWorkbookCredentials;
  }

  // Environment variables are the legacy PMG fallback. They must never be used
  // by Citrus Valley because they are not scoped to a subportal.
  if (subportalDefinition.allowEnvironmentCredentials) {
    const envCredentials = loadAerialCredentialsFromEnv();
    if (envCredentials) return envCredentials;
  }

  const workbookCredentials = loadAerialCredentialsFromWorkbook(inputWorkbookBuffer, subportal);
  if (workbookCredentials) return workbookCredentials;

  throw new Error(
    `Missing ${AERIAL_SUBPORTAL_LABELS[subportal]} credentials. Upload an Aerial login Excel containing a matching Sub portal row with Login URL, Username, and Password.${subportal === "pmg" ? " Existing PMG environment credentials remain supported." : ""}`,
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
  const subportal = resolveAerialSubportal(formData.get("aerialSubportal")).id;
  const credentialExcel = formData.get("credentialExcel");
  const inputExcel = formData.get("inputExcel");
  const credentialWorkbookBuffer = await loadOptionalWorkbookBuffer(credentialExcel);
  const inputWorkbook = await loadInputWorkbookBuffer(inputExcel);

  return {
    subportal,
    credentials: resolveAerialCredentials(subportal, inputWorkbook.buffer, credentialWorkbookBuffer),
    inputWorkbookBuffer: inputWorkbook.buffer,
    inputFileName: inputWorkbook.fileName,
  };
}
