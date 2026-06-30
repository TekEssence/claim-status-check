import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ScraperContext } from "../types";
import { launchBlueShieldPersistentContext } from "./browser";
import {
  BlueShieldSecurityDetectionError,
  attachBlueShieldDetectionMonitor,
} from "./detection-monitor";
import {
  createUniqueMemberWorkItems,
  parseBlueShieldInput,
  readBlueShieldInputWorkbook,
} from "./input";
import { loginToBlueShield } from "./login";
import {
  clearBlueShieldCheckpoint,
  readBlueShieldCheckpoint,
  saveBlueShieldCheckpoint,
} from "./checkpoint-service";
import {
  createBlueShieldOutputWorkbookBuffer,
  createBlueShieldWorkbookState,
  type BlueShieldWorkbookState,
} from "./output-writer";
import {
  navigateToBlueShieldClaimStatus,
  searchBlueShieldClaims,
} from "./claim-status";
import { extractAllBlueShieldClaims } from "./claim-extraction";
import { blueShieldWritableDataPath } from "./storage";
import type { BlueShieldAuditRow, BlueShieldClaimSummary, BlueShieldErrorRow, BlueShieldInputRow, BlueShieldMemberWorkItem, BlueShieldOutputRow } from "./types";

const BLUE_SHIELD_SAVE_INTERVAL = 5;

function nowIso(): string {
  return new Date().toISOString();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addAudit(
  state: BlueShieldWorkbookState,
  memberId: string,
  step: string,
  status: string,
  startedAt: number,
  message = "",
): void {
  state.auditRows.push({
    timestamp: nowIso(),
    member_id: memberId,
    step,
    status,
    duration_ms: Date.now() - startedAt,
    message,
  } satisfies BlueShieldAuditRow);
}

function addError(
  state: BlueShieldWorkbookState,
  member: BlueShieldMemberWorkItem | null,
  page: Page | null,
  errorType: string,
  message: string,
): void {
  state.errorRows.push({
    timestamp: nowIso(),
    member_id: member?.memberId ?? "",
    dos: member?.dosValues.join(", ") ?? "",
    error_type: errorType,
    error_message: message,
    portal_url: page?.url() ?? "",
  } satisfies BlueShieldErrorRow);
}

function workItemKey(member: BlueShieldMemberWorkItem): string {
  return `${member.memberId.trim().toUpperCase()}::${member.dosValues.join("|").trim().toUpperCase()}`;
}

function downloadableFileEvent(filename: string, buffer: Buffer, mimeType: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: buffer.toString("base64"),
    mimeType,
  };
}

function outputWorkbookFilename(group: string): string {
  const safeGroup = group.trim().replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "") || "BlueShield";
  return `${safeGroup}_Output.xlsx`;
}

function normalizeProcedureCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "");
}

function dateKeysFromText(value: string): string[] {
  const keys: string[] = [];
  const matches = value.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})\b/g);
  for (const match of matches) {
    const month = match[1].padStart(2, "0");
    const day = match[2].padStart(2, "0");
    const year = match[3].length === 2 ? `20${match[3]}` : match[3];
    keys.push(`${year}-${month}-${day}`);
  }
  return keys;
}

function firstDateKeyFromText(value: string): string {
  return dateKeysFromText(value)[0] ?? "";
}

function newestDateKeyFromText(...values: string[]): string {
  return values
    .flatMap(dateKeysFromText)
    .sort()
    .at(-1) ?? "";
}

function claimRecencyKey(claim: BlueShieldClaimSummary): string {
  return firstDateKeyFromText(claim.listClaimStatusLastModified)
    || newestDateKeyFromText(
      claim.paidDate,
      claim.checkEftDate,
      claim.claimReceived,
    )
    || newestDateKeyFromText(
      claim.serviceLineDatesOfService,
      claim.detailDatesOfService,
      claim.datesOfService,
      claim.serviceDate,
    );
}

function keepMostRecentClaims(claims: BlueShieldClaimSummary[]): BlueShieldClaimSummary[] {
  const keys = claims.map(claimRecencyKey).filter(Boolean);
  if (!keys.length) return claims;

  const newestKey = keys.sort().at(-1);
  return claims.filter((claim) => claimRecencyKey(claim) === newestKey);
}

function outputClaimIdentityKey(claim: BlueShieldClaimSummary): string {
  return [
    claim.serviceLineNumber,
    claim.serviceLineDatesOfService,
    claim.procedureCode,
    claim.modifier,
    claim.serviceLineAmountBilled,
    claim.serviceLineAmountPaid,
  ]
    .map((value) => String(value || "").replace(/\s+/g, " ").trim().toUpperCase())
    .join("::");
}

function uniqueClaimsForOutput(claims: BlueShieldClaimSummary[]): BlueShieldClaimSummary[] {
  const seen = new Set<string>();
  return claims.filter((claim) => {
    const key = outputClaimIdentityKey(claim);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function claimMatchesInputDos(claim: BlueShieldClaimSummary, inputDos: string): boolean {
  const inputDosKey = firstDateKeyFromText(inputDos);
  if (!inputDosKey) return true;

  const claimDosKeys = new Set(
    [
      claim.serviceLineDatesOfService,
      claim.detailDatesOfService,
      claim.datesOfService,
      claim.serviceDate,
    ].flatMap(dateKeysFromText),
  );
  return claimDosKeys.has(inputDosKey);
}

function inputData(row: BlueShieldInputRow): Record<string, unknown> {
  const { inputRowId, memberId, dos, cptCode, validationStatus, validationMessage, ...data } = row;
  return data;
}

function cleanFinalStatusPart(value: string): string {
  return String(value || "")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function moneyToNumber(value: string): number {
  const amount = Number(String(value || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function isPaidClaim(claim: BlueShieldClaimSummary): boolean {
  if (/paid/i.test(claim.claimStatus) && !/denied/i.test(claim.claimStatus)) return true;
  const paidAmount = claim.serviceLineAmountPaid || claim.detailAmountPaid || claim.claimAmountPaid || claim.paidAmount;
  return moneyToNumber(paidAmount) > 0;
}

export function buildBlueShieldFinalStatus(row: BlueShieldInputRow, claim: BlueShieldClaimSummary): string {
  const dos = row.dos || claim.serviceLineDatesOfService || claim.detailDatesOfService || claim.datesOfService || "";
  const received = claim.receivedDate || claim.claimReceived || "";
  const claimNumber = claim.claimNumber || "";
  const paidAmount = claim.serviceLineAmountPaid || claim.detailAmountPaid || claim.claimAmountPaid || claim.paidAmount || "";

  if (isPaidClaim(claim)) {
    const paidDate = claim.paidDate || claim.checkEftDate || claim.listClaimStatusLastModified || "";
    return `DOS ${dos}: Checked BSC portal claim received on ${received} paid on ${paidDate} paid amount ${paidAmount} EFT/Check # ${claim.checkEftNumber || ""}. Claim # ${claimNumber}.`;
  }

  const deniedDate = claim.listClaimStatusLastModified || claim.paidDate || claim.checkEftDate || "";
  const denialReason = cleanFinalStatusPart(claim.claimNotes || claim.claimStatus || "");
  const denialReasonSuffix = denialReason.endsWith(".") ? "" : ".";
  return `DOS ${dos}: Checked BSC portal claim received on ${received} denied on ${deniedDate} denial reason ${denialReason}${denialReasonSuffix} Claim# ${claimNumber}.`;
}

function outputRowForClaim(row: BlueShieldInputRow, claim: BlueShieldClaimSummary, message = ""): BlueShieldOutputRow {
  return {
    inputRowId: row.inputRowId,
    inputData: inputData(row),
    botStatus: claim.claimStatus || "Matched",
    botMessage: message,
    botPlanType: claim.planType || claim.ipaMedGroup,
    botClaimNumber: claim.claimNumber,
    botClaimStatus: claim.claimStatus,
    botProcedureCode: claim.procedureCode,
    botModifier: claim.modifier,
    botServiceLineNumber: claim.serviceLineNumber,
    botServiceLineDatesOfService: claim.serviceLineDatesOfService,
    botAmountBilled: claim.serviceLineAmountBilled || claim.detailAmountBilled || claim.claimAmountBilled,
    botAllowedAmount: claim.serviceLineAllowedAmount || claim.allowedAmount,
    botDeductible: claim.serviceLineDeductible,
    botCopay: claim.serviceLineCopay,
    botCoInsurance: claim.serviceLineCoInsurance,
    botAmountPaid: claim.serviceLineAmountPaid || claim.detailAmountPaid || claim.claimAmountPaid,
    botClaimNotes: claim.claimNotes,
    finalStatus: buildBlueShieldFinalStatus(row, claim),
  };
}

function outputRowWithoutClaim(row: BlueShieldInputRow, message: string): BlueShieldOutputRow {
  return {
    inputRowId: row.inputRowId,
    inputData: inputData(row),
    botStatus: "Not Found",
    botMessage: message,
    botPlanType: "",
    botClaimNumber: "",
    botClaimStatus: "",
    botProcedureCode: "",
    botModifier: "",
    botServiceLineNumber: "",
    botServiceLineDatesOfService: "",
    botAmountBilled: "",
    botAllowedAmount: "",
    botDeductible: "",
    botCopay: "",
    botCoInsurance: "",
    botAmountPaid: "",
    botClaimNotes: "",
    finalStatus: `DOS ${row.dos}: Checked BSC portal ${message}`,
  };
}

export function alignClaimsToInputRows(rows: BlueShieldInputRow[], member: BlueShieldMemberWorkItem, claims: BlueShieldClaimSummary[]): BlueShieldOutputRow[] {
  const memberRows = member.rowIds
    .map((rowId) => rows.find((row) => row.inputRowId === rowId))
    .filter((row): row is BlueShieldInputRow => Boolean(row));
  const outputRows: BlueShieldOutputRow[] = [];

  for (const row of memberRows) {
    const inputCpt = normalizeProcedureCode(row.cptCode);
    const dosMatchedClaims = claims.filter((claim) => claimMatchesInputDos(claim, row.dos));
    const matchingClaims = inputCpt
      ? dosMatchedClaims.filter((claim) => normalizeProcedureCode(claim.procedureCode) === inputCpt)
      : dosMatchedClaims;
    const newestMatchingClaims = uniqueClaimsForOutput(keepMostRecentClaims(matchingClaims));

    if (!newestMatchingClaims.length) {
      outputRows.push(outputRowWithoutClaim(
        row,
        inputCpt
          ? `No service line matched input DOS ${row.dos} and CPT ${row.cptCode}.`
          : `No matching claim or service line was found for input DOS ${row.dos}.`,
      ));
      continue;
    }

    for (const claim of newestMatchingClaims) {
      outputRows.push(outputRowForClaim(row, claim, inputCpt ? "Matched by Member ID, DOS, and CPT." : "Matched by Member ID and DOS."));
    }
  }

  return outputRows;
}

async function saveWorkbook(jobId: string, state: BlueShieldWorkbookState, filename: string): Promise<{ buffer: Buffer; filePath: string }> {
  const buffer = await createBlueShieldOutputWorkbookBuffer(state);
  const outputDir = blueShieldWritableDataPath("outputs", "blue-shield", jobId);
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, filename);
  await fs.writeFile(filePath, buffer);
  return { buffer, filePath };
}

async function saveErrorLog(jobId: string, state: BlueShieldWorkbookState): Promise<{ buffer: Buffer; filePath: string }> {
  const content = state.errorRows
    .map((row) => `[${row.timestamp}] ${row.member_id} ${row.error_type}: ${row.error_message} (${row.portal_url})`)
    .join("\n");
  const logDir = blueShieldWritableDataPath("logs", "blue-shield", jobId);
  await fs.mkdir(logDir, { recursive: true });
  const filePath = path.join(logDir, "blue-shield-error.log");
  const buffer = Buffer.from(content || "No Blue Shield errors were recorded.", "utf8");
  await fs.writeFile(filePath, buffer);
  return { buffer, filePath };
}

export async function runBlueShieldClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parseBlueShieldInput(formData);
  if (input.resetCheckpoint) {
    await clearBlueShieldCheckpoint(input.checkpointId);
  }

  const rows = readBlueShieldInputWorkbook(input.inputWorkbookBuffer);
  const workItems = createUniqueMemberWorkItems(rows);
  const state = createBlueShieldWorkbookState();
  const invalidRows = rows.filter((row) => row.validationStatus === "invalid");
  let completedWorkItems = new Set<string>();
  let outputWorkbookPath = "";
  let page: Page | null = null;
  let contextHandle: Awaited<ReturnType<typeof launchBlueShieldPersistentContext>> | null = null;
  const workbookFilename = outputWorkbookFilename(input.selectedGroup);

  const log = async (message: string) => context.log({ level: "info", message });
  await log(`Blue Shield input loaded for ${input.selectedGroup}: ${rows.length} row(s), ${workItems.length} unique member/DOS search(es).`);
  const duplicateCount = workItems.reduce((count, item) => count + item.duplicateRowIds.length, 0);
  if (duplicateCount > 0) {
    await log(`Blue Shield skipped ${duplicateCount} duplicate input row(s) with the same Member ID and DOS.`);
  }

  invalidRows.forEach((row) => {
    state.outputRows.push(outputRowWithoutClaim(row, row.validationMessage));
    state.errorRows.push({
      timestamp: nowIso(),
      member_id: row.memberId,
      dos: row.dos,
      error_type: "validation",
      error_message: row.validationMessage,
      portal_url: "",
    });
  });

  const checkpoint = await readBlueShieldCheckpoint(input.checkpointId);
  if (checkpoint) {
    await clearBlueShieldCheckpoint(input.checkpointId);
    await log(`Blue Shield found an old checkpoint after member ${checkpoint.lastCompletedMember}. Cleared it so this run will reprocess every member.`);
  }

  await context.emit({ type: "progress", completed: completedWorkItems.size, total: workItems.length });

  try {
    contextHandle = await launchBlueShieldPersistentContext(log);
    page = contextHandle.pages()[0] ?? await contextHandle.newPage();
    attachBlueShieldDetectionMonitor(page);

    await loginToBlueShield({ page, credentials: input.credentials, log });

    for (const member of workItems) {
      const currentWorkItemKey = workItemKey(member);
      if (completedWorkItems.has(currentWorkItemKey)) {
        continue;
      }

      const memberStartedAt = Date.now();
      try {
        addAudit(state, member.memberId, "member_started", "started", memberStartedAt);
        await navigateToBlueShieldClaimStatus(page, input.credentials);
        const searchResult = await searchBlueShieldClaims({ page, workItem: member, log });
        const claims = await extractAllBlueShieldClaims({
          page,
          workItem: member,
          dosSearched: searchResult.dosSearched,
          log,
        });

        state.outputRows.push(...alignClaimsToInputRows(rows, member, claims));
        addAudit(state, member.memberId, "member_completed", "completed", memberStartedAt, `Extracted ${claims.length} claim(s).`);
        completedWorkItems.add(currentWorkItemKey);

        const shouldSaveIntermediateWorkbook = completedWorkItems.size % BLUE_SHIELD_SAVE_INTERVAL === 0;
        if (shouldSaveIntermediateWorkbook) {
          const saved = await saveWorkbook(context.jobId, state, workbookFilename);
          outputWorkbookPath = saved.filePath;
          await saveBlueShieldCheckpoint({
            checkpointId: input.checkpointId,
            lastCompletedMember: member.memberId,
            completedMembers: Array.from(completedWorkItems),
            outputWorkbookPath,
            updatedAt: nowIso(),
          });
        }
        await log(
          shouldSaveIntermediateWorkbook
            ? `Blue Shield member ${member.memberId} completed and checkpoint saved.`
            : `Blue Shield member ${member.memberId} completed.`,
        );
        await context.emit({ type: "progress", completed: completedWorkItems.size, total: workItems.length });
      } catch (error) {
        const message = errorMessage(error);
        const isSecurity = error instanceof BlueShieldSecurityDetectionError;
        addError(state, member, page, isSecurity ? error.reason : "member_processing", message);
        await saveWorkbook(context.jobId, state, workbookFilename);
        await saveErrorLog(context.jobId, state);
        await saveBlueShieldCheckpoint({
          checkpointId: input.checkpointId,
          lastCompletedMember: Array.from(completedWorkItems).at(-1) ?? "",
          completedMembers: Array.from(completedWorkItems),
          outputWorkbookPath,
          updatedAt: nowIso(),
        });

        if (isSecurity) {
          await context.emit({ type: "error", message });
          break;
        }

        addAudit(state, member.memberId, "member_failed", "failed", memberStartedAt, message);
        await context.emit({ type: "progress", completed: completedWorkItems.size, total: workItems.length });
      }
    }

    const finalWorkbook = await saveWorkbook(context.jobId, state, workbookFilename);
    await context.emit(downloadableFileEvent(workbookFilename, finalWorkbook.buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));

    if (state.errorRows.length > 0) {
      const errorLog = await saveErrorLog(context.jobId, state);
      await context.emit(downloadableFileEvent("blue-shield-error.log", errorLog.buffer, "text/plain"));
      await context.emit({ type: "warning", message: `Blue Shield completed with ${state.errorRows.length} error(s).` });
    }
  } catch (error) {
    const message = errorMessage(error);
    addError(state, null, page, "job_failure", message);
    const workbookFilename = outputWorkbookFilename(input?.selectedGroup ?? "BlueShield");
    await saveWorkbook(context.jobId, state, workbookFilename).catch(() => {});
    const errorLog = await saveErrorLog(context.jobId, state).catch(() => null);
    if (errorLog) {
      await context.emit(downloadableFileEvent("blue-shield-error.log", errorLog.buffer, "text/plain"));
    }
    await context.emit({ type: "error", message });
  } finally {
    await contextHandle?.close().catch(() => {});
    await context.emit({ type: "done" });
  }
}
