import fs from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ScraperContext } from "../../types";
import { launchBlueShieldPersistentContext } from "./browser";
import {
  BlueShieldSecurityDetectionError,
  attachBlueShieldDetectionMonitor,
  clearBlueShieldDetectionMonitor,
} from "./detection-monitor";
import {
  createUniqueMemberWorkItems,
  parseBlueShieldInput,
  readBlueShieldInputWorkbook,
  routeBlueShieldRowsByCredentials,
} from "./input";
import { loginToBlueShield, logoutFromBlueShield } from "./login";
import {
  clearBlueShieldCheckpoint,
  readBlueShieldCheckpoint,
  saveBlueShieldCheckpoint,
} from "./checkpoint-service";
import {
  createBlueShieldOutputWorkbookBuffer,
  createBlueShieldErrorReportBuffer,
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
const BLUE_SHIELD_MAX_BATCH_RECOVERIES = 3;

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
  return `${member.memberId.trim().toUpperCase()}::${member.dosValues.join("|").trim().toUpperCase()}::${member.rowIds.join(",")}`;
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
  return value.trim().replace(/\.0+$/, "").toUpperCase().replace(/[^A-Z0-9]+/g, "");
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

  const claimDosValues = [
    claim.serviceLineDatesOfService,
    claim.detailDatesOfService,
    claim.datesOfService,
    claim.serviceDate,
  ];
  const claimDosKeys = new Set(claimDosValues.flatMap(dateKeysFromText));
  if (claimDosKeys.has(inputDosKey)) return true;

  return claimDosValues.some((value) => {
    const keys = dateKeysFromText(value);
    if (keys.length < 2) return false;
    const sorted = keys.sort();
    return inputDosKey >= sorted[0] && inputDosKey <= sorted[sorted.length - 1];
  });
}

function inputData(row: BlueShieldInputRow): Record<string, unknown> {
  const { inputRowId, group, memberId, dos, cptCode, validationStatus, validationMessage, ...data } = row;
  return data;
}

function addMemberFailureOutput(
  state: BlueShieldWorkbookState,
  rows: BlueShieldInputRow[],
  member: BlueShieldMemberWorkItem,
  message: string,
): void {
  for (const rowId of member.rowIds) {
    const row = rows.find((candidate) => candidate.inputRowId === rowId);
    if (row) state.outputRows.push(outputRowWithoutClaim(row, message));
  }
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

function isPendingClaim(claim: BlueShieldClaimSummary): boolean {
  return /pending/i.test(claim.claimStatus);
}

function outputBotStatusForClaim(claim: BlueShieldClaimSummary): "Paid" | "Denied" | "Claim pending" {
  if (isPendingClaim(claim)) return "Claim pending";
  return isPaidClaim(claim) ? "Paid" : "Denied";
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

  if (isPendingClaim(claim)) {
    return `DOS ${dos}: Checked BSC portal claim received on ${received} claim pending. Claim# ${claimNumber}.`;
  }

  const deniedDate = claim.listClaimStatusLastModified || claim.paidDate || claim.checkEftDate || "";
  const denialReason = cleanFinalStatusPart(claim.claimNotes || claim.claimStatus || "");
  const denialReasonSuffix = denialReason.endsWith(".") ? "" : ".";
  return `DOS ${dos}: Checked BSC portal claim received on ${received} denied on ${deniedDate} denial reason ${denialReason}${denialReasonSuffix} Claim# ${claimNumber}.`;
}

function outputRowForClaim(row: BlueShieldInputRow, claim: BlueShieldClaimSummary, message = ""): BlueShieldOutputRow {
  const botStatus = outputBotStatusForClaim(claim);
  return {
    inputRowId: row.inputRowId,
    inputData: inputData(row),
    botStatus,
    botMessage: message,
    botPlanType: claim.planType || claim.ipaMedGroup,
    botClaimNumber: claim.claimNumber,
    botClaimStatus: claim.claimStatus || botStatus,
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
    const selectedClaim = uniqueClaimsForOutput(matchingClaims)[0];

    if (!selectedClaim) {
      const extractedDos = Array.from(new Set(claims.flatMap((claim) => [
        claim.serviceLineDatesOfService,
        claim.detailDatesOfService,
        claim.datesOfService,
      ]).filter(Boolean))).join(", ") || "(blank)";
      const extractedCpt = Array.from(new Set(dosMatchedClaims.map((claim) => claim.procedureCode).filter(Boolean))).join(", ") || "(blank)";
      outputRows.push(outputRowWithoutClaim(
        row,
        !dosMatchedClaims.length
          ? `No claims found for input DOS ${row.dos}. Portal DOS: ${extractedDos}.`
          : inputCpt
          ? `No service line matched input DOS ${row.dos} and CPT ${row.cptCode}. Portal DOS: ${extractedDos}; portal CPT: ${extractedCpt}.`
          : `No matching claim or service line was found for input DOS ${row.dos}. Portal DOS: ${extractedDos}.`,
      ));
      continue;
    }

    outputRows.push(outputRowForClaim(row, selectedClaim, inputCpt ? "Matched by Member ID, DOS, and CPT." : "Matched by Member ID and DOS."));
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

async function saveErrorReport(
  jobId: string,
  state: BlueShieldWorkbookState,
): Promise<{ buffer: Buffer; filePath: string }> {
  const buffer = await createBlueShieldErrorReportBuffer(state.errorRows);
  const reportDir = blueShieldWritableDataPath("outputs", "blue-shield", jobId);
  await fs.mkdir(reportDir, { recursive: true });
  const filePath = path.join(reportDir, "blue-shield-error-report.xlsx");
  await fs.writeFile(filePath, buffer);
  return { buffer, filePath };
}

async function emitErrorArtifacts(
  context: ScraperContext,
  state: BlueShieldWorkbookState,
): Promise<void> {
  const errorLog = await saveErrorLog(context.jobId, state);
  await context.emit(downloadableFileEvent(
    "blue-shield-error-report.txt",
    errorLog.buffer,
    "text/plain",
  ));
}

async function recoverBlueShieldBatchSession(options: {
  page: Page;
  credentials: Parameters<typeof loginToBlueShield>[0]["credentials"];
  context: ScraperContext;
  log: (message: string) => Promise<void>;
  reason: string;
}): Promise<void> {
  const { page, credentials, context, log, reason } = options;
  await log(`Blue Shield is resetting the current login before continuing. Reason: ${reason}`);
  clearBlueShieldDetectionMonitor(page);
  await logoutFromBlueShield(page, log).catch(async (error) => {
    await log(`Blue Shield logout during recovery did not complete cleanly: ${errorMessage(error)}. Clearing browser cookies instead.`);
    await page.context().clearCookies().catch(() => {});
  });
  clearBlueShieldDetectionMonitor(page);
  await loginToBlueShield({ page, credentials, context, log });
}

async function closeBlueShieldBatchContext(options: {
  page: Page | null;
  contextHandle: Awaited<ReturnType<typeof launchBlueShieldPersistentContext>> | null;
  log: (message: string) => Promise<void>;
}): Promise<void> {
  const { page, contextHandle, log } = options;
  if (page) {
    await logoutFromBlueShield(page, log).catch(async (error) => {
      await log(`Blue Shield logout before closing credential batch did not complete cleanly: ${errorMessage(error)}.`);
    });
  }
  await contextHandle?.close().catch(() => {});
}

export async function runBlueShieldClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parseBlueShieldInput(formData);
  if (input.resetCheckpoint) {
    await clearBlueShieldCheckpoint(input.checkpointId);
  }

  const rows = readBlueShieldInputWorkbook(input.inputWorkbookBuffer);
  const routing = routeBlueShieldRowsByCredentials(rows, input.credentialWorkbookBuffer);
  const batches = routing.batches.map((batch) => ({
    ...batch,
    workItems: createUniqueMemberWorkItems(batch.rows),
  }));
  const totalWorkItems = batches.reduce((total, batch) => total + batch.workItems.length, 0);
  const state = createBlueShieldWorkbookState();
  const invalidRows = rows.filter((row) => row.validationStatus === "invalid");
  const completedWorkItems = new Set<string>();
  let outputWorkbookPath = "";
  let page: Page | null = null;
  let contextHandle: Awaited<ReturnType<typeof launchBlueShieldPersistentContext>> | null = null;
  const workbookFilename = outputWorkbookFilename("BlueShield");

  const log = async (message: string) => context.log({ level: "info", message });
  await log(`Blue Shield input loaded: ${rows.length} row(s), ${batches.length} unique credential login(s), ${totalWorkItems} unique member/DOS search(es).`);
  const duplicateCount = batches.reduce(
    (count, batch) => count + batch.workItems.reduce((batchCount, item) => batchCount + item.duplicateRowIds.length, 0),
    0,
  );
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
  routing.unmappedRows.forEach((row) => {
    const message = `Missing Blue Shield credentials for group ${row.group}.`;
    state.outputRows.push(outputRowWithoutClaim(row, message));
    state.errorRows.push({
      timestamp: nowIso(),
      member_id: row.memberId,
      dos: row.dos,
      error_type: "credential_mapping",
      error_message: message,
      portal_url: "",
    });
  });
  if (routing.unmappedRows.length > 0) {
    await log(`Blue Shield skipped ${routing.unmappedRows.length} row(s) whose Group did not match the credential workbook.`);
  }
  const checkpoint = await readBlueShieldCheckpoint(input.checkpointId);
  if (checkpoint) {
    await clearBlueShieldCheckpoint(input.checkpointId);
    await log(`Blue Shield found an old checkpoint after member ${checkpoint.lastCompletedMember}. Cleared it so this run will reprocess every member.`);
  }

  await context.emit({ type: "progress", completed: completedWorkItems.size, total: totalWorkItems });

  try {
    if (batches.length === 0) {
      throw new Error("No Blue Shield rows could be matched to login credentials.");
    }

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      await log(`Blue Shield logging in for group(s) ${batch.groups.join(", ")} to process ${batch.rows.length} row(s).`);
      let batchSecurityFailure = "";
      let batchRecoveryCount = 0;
      try {
        if (contextHandle) {
          await closeBlueShieldBatchContext({ page, contextHandle, log });
          page = null;
          contextHandle = null;
        }

        contextHandle = await launchBlueShieldPersistentContext(log, batch.credentials);
        page = contextHandle.pages()[0] ?? await contextHandle.newPage();
        attachBlueShieldDetectionMonitor(page);
        await loginToBlueShield({ page, credentials: batch.credentials, context, log });

        for (const member of batch.workItems) {
          const currentWorkItemKey = workItemKey(member);
          if (completedWorkItems.has(currentWorkItemKey)) continue;

          const memberStartedAt = Date.now();
          try {
            addAudit(state, member.memberId, "member_started", "started", memberStartedAt);
            await navigateToBlueShieldClaimStatus(page, batch.credentials);
            const searchResult = await searchBlueShieldClaims({ page, workItem: member, log });
            const claims = await extractAllBlueShieldClaims({
              page,
              workItem: member,
              dosSearched: searchResult.dosSearched,
              log,
            });

            state.outputRows.push(...alignClaimsToInputRows(batch.rows, member, claims));
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
            await context.emit({ type: "progress", completed: completedWorkItems.size, total: totalWorkItems });
          } catch (error) {
            const message = errorMessage(error);
            const isSecurity = error instanceof BlueShieldSecurityDetectionError;
            addError(state, member, page, isSecurity ? error.reason : "member_processing", message);
            addMemberFailureOutput(state, batch.rows, member, message);
            completedWorkItems.add(currentWorkItemKey);
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
              addAudit(state, member.memberId, "member_failed", "failed", memberStartedAt, message);
              await context.emit({ type: "progress", completed: completedWorkItems.size, total: totalWorkItems });

              if (batchRecoveryCount >= BLUE_SHIELD_MAX_BATCH_RECOVERIES) {
                batchSecurityFailure = message;
                await context.emit({
                  type: "warning",
                  message: `Blue Shield stopped the ${batch.groups.join(", ")} credential batch after repeated security responses and will continue with the next login.`,
                });
                break;
              }

              batchRecoveryCount++;
              await context.emit({
                type: "warning",
                message: `Blue Shield hit a security response for ${member.memberId}. The current login will be reset, then remaining rows for this same login will continue.`,
              });
              await recoverBlueShieldBatchSession({
                page,
                credentials: batch.credentials,
                context,
                log,
                reason: message,
              });
              continue;
            }

            addAudit(state, member.memberId, "member_failed", "failed", memberStartedAt, message);
            await context.emit({ type: "progress", completed: completedWorkItems.size, total: totalWorkItems });
          }
        }

        if (batchSecurityFailure) {
          for (const skippedMember of batch.workItems) {
            const skippedKey = workItemKey(skippedMember);
            if (completedWorkItems.has(skippedKey)) continue;
            const message = `Skipped because this credential batch was stopped after: ${batchSecurityFailure}`;
            addError(state, skippedMember, page, "credential_batch_stopped", message);
            addMemberFailureOutput(state, batch.rows, skippedMember, message);
            completedWorkItems.add(skippedKey);
          }
          await context.emit({
            type: "progress",
            completed: completedWorkItems.size,
            total: totalWorkItems,
          });
        }
      } catch (error) {
        const failure = errorMessage(error);
        const errorType = error instanceof BlueShieldSecurityDetectionError
          ? error.reason
          : "credential_batch_login";
        for (const skippedMember of batch.workItems) {
          const skippedKey = workItemKey(skippedMember);
          if (completedWorkItems.has(skippedKey)) continue;
          addError(state, skippedMember, page, errorType, failure);
          addMemberFailureOutput(state, batch.rows, skippedMember, failure);
          completedWorkItems.add(skippedKey);
        }
        await context.log({
          level: "error",
          message: `Blue Shield credential batch ${batch.groups.join(", ")} failed before completion: ${failure}`,
          eventName: "blue_shield_credential_batch_failed",
          meta: { groups: batch.groups, errorType },
        });
        await context.emit({
          type: "warning",
          message: `Blue Shield could not process the ${batch.groups.join(", ")} credential batch and will continue with the next login: ${failure}`,
        });
        await context.emit({
          type: "progress",
          completed: completedWorkItems.size,
          total: totalWorkItems,
        });
      }
    }

    const finalWorkbook = await saveWorkbook(context.jobId, state, workbookFilename);
    await context.emit(downloadableFileEvent(workbookFilename, finalWorkbook.buffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));

    if (state.errorRows.length > 0) {
      await emitErrorArtifacts(context, state);
      await context.emit({ type: "warning", message: `Blue Shield completed with ${state.errorRows.length} error(s).` });
    }
  } catch (error) {
    const message = errorMessage(error);
    addError(state, null, page, "job_failure", message);
    await saveWorkbook(context.jobId, state, workbookFilename).catch(() => {});
    await emitErrorArtifacts(context, state).catch(() => {});
    await context.emit({ type: "error", message });
  } finally {
    await contextHandle?.close().catch(() => {});
    contextHandle = null;
    page = null;
    await context.emit({ type: "done" });
  }
}
