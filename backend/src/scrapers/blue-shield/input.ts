import * as XLSX from "xlsx";
import { getSharedMfaMailbox } from "@/backend/src/core/mfa-otp-service";
import { envText, loadBlueShieldEnvironment } from "./env";
import type { BlueShieldCredentials, BlueShieldInput, BlueShieldInputRow, BlueShieldMemberWorkItem } from "./types";
import { blueShieldConfig } from "./config";

function asText(value: unknown): string {
  if (value instanceof Date) {
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${month}/${day}/${value.getFullYear()}`;
  }
  return value == null ? "" : String(value).trim();
}

function normalizeUrl(value: string): string {
  if (!value) return "";
  return value.startsWith("http") ? value : `https://${value}`;
}

function defaultClaimStatusUrl(loginUrl: string): string {
  try {
    const url = new URL(loginUrl);
    return `${url.origin}/providerwebapp/claims/claimStatus`;
  } catch {
    return "https://www.blueshieldca.com/providerwebapp/claims/claimStatus";
  }
}

function findValue(row: Record<string, unknown>, aliases: string[]): string {
  const wanted = aliases.map((alias) => alias.toLowerCase().replace(/[^a-z0-9]+/g, ""));
  for (const [key, value] of Object.entries(row)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (wanted.includes(normalizedKey)) {
      const text = asText(value);
      if (text) return text;
    }
  }
  return "";
}

const MEMBER_ID_ALIASES = [
  "Member ID",
  "MEMBER ID",
  "MEMBER_ID",
  "member_id",
  "MemberID",
  "Member Id",
  "Member Number",
  "Member No",
  "Member #",
  "Subscriber ID",
  "SUBSCRIBER_ID",
  "subscriber_id",
  "Subscriber No",
  "Subscriber Number",
  "Insurance ID",
  "Policy ID",
  "Member Policy ID",
];

const DOS_ALIASES = [
  "DOS",
  "Date Of Service",
  "DATE OF SERVICE",
  "DATE_OF_SERVICE",
  "date of service",
  "date_of_service",
  "Service Date",
  "SERVICE_DATE",
  "service_date",
  "Svc Date",
  "From DOS",
  "DOS From",
  "Date Service",
];

function normalizeGroupName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normalizeMemberId(value: string): string {
  return value.replace(/\s+/g, "").trim();
}

function normalizeDosKey(value: string): string {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!match) return trimmed.toUpperCase();

  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${month}-${day}`;
}

function loadCredentialsFromWorkbook(buffer: ArrayBuffer, selectedGroup: string): BlueShieldCredentials | null {
  const workbook = XLSX.read(buffer, { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return null;

  const rows = XLSX.utils.sheet_to_json(sheet) as Record<string, unknown>[];
  const selectedGroupKey = normalizeGroupName(selectedGroup);
  for (const row of rows) {
    const group = findValue(row, ["Group", "Payer", "Portal", "Portal Group"]);
    if (!group || normalizeGroupName(group) !== selectedGroupKey) {
      continue;
    }

    const loginUrl = normalizeUrl(findValue(row, ["URL", "Portal Link", "Login URL", "Blue Shield URL"]));
    const username = findValue(row, ["User Name", "Username", "PORTAL_BLUE_SHIELD_USERNAME"]);
    const password = findValue(row, ["Password", "PORTAL_BLUE_SHIELD_PASSWORD"]);
    const claimStatusUrl = normalizeUrl(findValue(row, ["Claim Status URL", "Claim URL", "PORTAL_BLUE_SHIELD_CLAIM_STATUS_URL"])) || defaultClaimStatusUrl(loginUrl);
    const mailbox =
      findValue(row, ["MFA Mailbox", "Mailbox", "PORTAL_BLUE_SHIELD_MFA_MAILBOX"]) ||
      envText("PORTAL_BLUE_SHIELD_MFA_MAILBOX") ||
      getSharedMfaMailbox() ||
      blueShieldConfig.defaultMailbox;
    if (loginUrl && username && password && claimStatusUrl) {
      return { group, loginUrl, username, password, claimStatusUrl, mailbox };
    }
  }
  return null;
}

async function loadOptionalWorkbookBuffer(file: FormDataEntryValue | null): Promise<ArrayBuffer | null> {
  return file instanceof File ? file.arrayBuffer() : null;
}

function resolveCredentials(
  credentialWorkbook: ArrayBuffer | null,
  selectedGroup: string,
): BlueShieldCredentials {
  if (!credentialWorkbook) {
    throw new Error("Missing Blue Shield login Excel file.");
  }

  const workbookCredentials = loadCredentialsFromWorkbook(credentialWorkbook, selectedGroup);
  if (workbookCredentials) return workbookCredentials;

  throw new Error(`Missing Blue Shield credentials for group ${selectedGroup}. Upload a login Excel with Group, URL, User Name, and Password columns.`);
}

export async function parseBlueShieldInput(formData: FormData): Promise<BlueShieldInput> {
  loadBlueShieldEnvironment();
  const credentialWorkbook = await loadOptionalWorkbookBuffer(formData.get("credentialExcel"));
  const inputExcel = formData.get("inputExcel");
  const selectedGroup = asText(formData.get("group")) || "Posada";

  if (!(inputExcel instanceof File)) {
    throw new Error("Missing Blue Shield input Excel file.");
  }

  const inputWorkbookBuffer = await inputExcel.arrayBuffer();
  return {
    credentials: resolveCredentials(credentialWorkbook, selectedGroup),
    selectedGroup,
    inputWorkbookBuffer,
    inputFileName: inputExcel.name || "blue_shield_input.xlsx",
    checkpointId: asText(formData.get("checkpointId")) || inputExcel.name || "blue-shield",
    resetCheckpoint: asText(formData.get("resetCheckpoint")).toLowerCase() === "true",
  };
}

export function readBlueShieldInputWorkbook(buffer: ArrayBuffer): BlueShieldInputRow[] {
  const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) {
    throw new Error("Blue Shield input workbook does not contain any sheets.");
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: "" }) as Record<string, unknown>[];
  return rows
    .map((row, index) => {
      const memberId = normalizeMemberId(findValue(row, MEMBER_ID_ALIASES));
      const dos = findValue(row, DOS_ALIASES);
      const missing = [
        !memberId ? "Member ID" : "",
        !dos ? "DOS" : "",
      ].filter(Boolean);
      return {
        ...row,
        inputRowId: index + 2,
        memberId,
        dos,
        validationStatus: missing.length ? "invalid" : "valid",
        validationMessage: missing.length ? `Missing ${missing.join(" and ")}.` : "",
      } satisfies BlueShieldInputRow;
    })
    .filter((row) => row.memberId || row.dos);
}

export function createUniqueMemberWorkItems(rows: BlueShieldInputRow[]): BlueShieldMemberWorkItem[] {
  const workItems = new Map<string, BlueShieldMemberWorkItem>();
  for (const row of rows.filter((inputRow) => inputRow.validationStatus === "valid")) {
    const memberId = normalizeMemberId(row.memberId);
    const dos = row.dos.trim();
    const key = `${memberId.toUpperCase()}::${normalizeDosKey(dos)}`;
    const existing = workItems.get(key);
    if (existing) {
      existing.duplicateRowIds.push(row.inputRowId);
      continue;
    }
    workItems.set(key, { memberId, dosValues: [dos], rowIds: [row.inputRowId], duplicateRowIds: [] });
  }
  return Array.from(workItems.values());
}
