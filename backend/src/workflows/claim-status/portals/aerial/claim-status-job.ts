import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { ScraperContext } from "../../types";
import { launchAerialBrowser } from "./browser";
import { AERIAL_SUBPORTAL_LABELS, parseAerialInput, type AerialInput } from "./input";
import { createAerialOutputWorkbookBuffer, readAerialInputWorkbookFromBuffer, type AerialInputRow } from "./workbook";
import { formatAerialLog, saveAerialLogFile } from "./log-file";
import { loadAerialEnvironment } from "./env";
import { aerialWritableDataPath } from "./storage";

type AerialLoginModule = {
  loginToAerial(page: Page, config: AerialRuntimeConfig): Promise<void>;
  goToClaims(page: Page, config: AerialRuntimeConfig): Promise<void>;
};

type AerialClaimsPageModule = {
  verifyClaimsSearchForm(page: Page): Promise<void>;
  searchClaims(page: Page, search: { subscriberNo: string; serviceDate: string; startDate?: string; endDate?: string }): Promise<void>;
  getOpenRecordCount(page: Page): Promise<number>;
  getMatchingOpenRecordIndexes(page: Page, criteria: { subscriberNo: string; serviceDate: string; matchSummaryDate?: boolean }): Promise<number[]>;
  openClaimDetailPopup(page: Page, index?: number): Promise<Page>;
  getPaginationState(page: Page): Promise<{ currentPage: number; nextEnabled: boolean }>;
  goToNextResultsPage(page: Page): Promise<boolean>;
};

type AerialDetailModule = {
  openEobAndExtractDetails(page: Page): Promise<Record<string, any>>;
};

type AerialRuntimeConfig = {
  loginUrl: string;
  username: string;
  password: string;
  successUrlFragment?: string;
  claimsUrl: string;
};

const { loginToAerial, goToClaims } = require("./aerial-login.js") as AerialLoginModule;
const {
  verifyClaimsSearchForm,
  searchClaims,
  getOpenRecordCount,
  getMatchingOpenRecordIndexes,
  openClaimDetailPopup,
  getPaginationState,
  goToNextResultsPage,
} = require("./claims-page.js") as AerialClaimsPageModule;
const { openEobAndExtractDetails } = require("./claim-detail-page.js") as AerialDetailModule;

type AerialRunState = {
  outputRows: Record<string, any>[];
  errorRows: Record<string, unknown>[];
  auditRows: Record<string, unknown>[];
};

function createRunId(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function baseOutputRow(inputRow: AerialInputRow): Record<string, any> {
  return {
    inputRowId: inputRow.input_row_id,
    inputClaimNo: inputRow["Claim No"] || "",
    subscriberNo: inputRow.normalized.subscriberNo,
    serviceDate: inputRow.normalized.serviceDate,
    claimStatus: "",
    result: "failed",
    notes: "",
    extractedAt: new Date().toISOString(),
  };
}

export function buildAerialNoDataOutputRow(inputRow: AerialInputRow): Record<string, any> {
  return {
    ...baseOutputRow(inputRow),
    memberId: inputRow.normalized.subscriberNo,
    claimStatus: "NO DATA",
    finalStatus: "No data found in portal.",
    result: "no_data",
    notes: "No claim data found in portal.",
    extractedAt: new Date().toISOString(),
  };
}

function moneyToNumber(value: unknown): number {
  const amount = Number(String(value || "").replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) ? amount : 0;
}

function formatMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

function calculateTotalPaid(serviceLines: Array<Record<string, unknown>> | undefined): string {
  const total = (serviceLines || []).reduce((sum, line) => sum + moneyToNumber(line.paid), 0);
  return formatMoney(total);
}

export function buildAerialFinalStatus(inputRow: AerialInputRow, details: Record<string, any>, totalPaid: string): string {
  const dos = inputRow.normalized.serviceDate || inputRow["Service Date"] || "";
  const received = details.dateReceived || "";
  const claimNumber = details.claimNumber || "";
  const claimStatus = String(details.claimStatus || "").trim().toUpperCase();

  if (claimStatus === "APPROVED") {
    return `DOS ${dos}: Checked IEHP portal claim received on ${received} paid on ${details.datePaid || ""} paid amount ${totalPaid} EFT/Check # ${details.checkNumber || ""}. Claim # ${claimNumber}.`;
  }

  const denialReason = details.denialReason || details.claimStatus || "";
  return `DOS ${dos}: Checked IEHP portal claim received on ${received} denied on ${details.rejectDate || ""} denial reason ${denialReason}. Claim# ${claimNumber}.`;
}

function addAudit(
  state: AerialRunState,
  runId: string,
  inputRow: AerialInputRow | null,
  page: Page | null,
  step: string,
  status: string,
  message = "",
): void {
  state.auditRows.push({
    run_id: runId,
    timestamp: new Date().toISOString(),
    input_row_id: inputRow?.input_row_id ?? "",
    input_claim_no: inputRow?.["Claim No"] ?? "",
    subscriber_no: inputRow?.normalized?.subscriberNo ?? "",
    service_date: inputRow?.normalized?.serviceDate ?? "",
    step,
    status,
    message,
    current_url: page?.url() ?? "",
  });
}

function addError(
  state: AerialRunState,
  runId: string,
  inputRow: AerialInputRow | null,
  page: Page | null,
  failureStage: string,
  failureReason: string,
  humanMessage: string,
  snapshotPath = "",
): void {
  state.errorRows.push({
    run_id: runId,
    timestamp: new Date().toISOString(),
    input_row_id: inputRow?.input_row_id ?? "",
    input_claim_no: inputRow?.["Claim No"] ?? "",
    subscriber_no: inputRow?.normalized?.subscriberNo ?? inputRow?.["Subscriber No"] ?? "",
    service_date: inputRow?.normalized?.serviceDate ?? inputRow?.["Service Date"] ?? "",
    failure_stage: failureStage,
    failure_reason: failureReason,
    human_message: humanMessage,
    current_url: page?.url() ?? "",
    snapshot_path: snapshotPath,
    needs_manual_review: "yes",
  });
}

async function captureAerialDiagnostics(
  context: ScraperContext,
  page: Page | null,
  inputRow: AerialInputRow,
  reason: string,
): Promise<string> {
  if (!page) return "";

  const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 60) || "error";
  const dir = aerialWritableDataPath("screenshots", "aerial", context.jobId);
  await fs.mkdir(dir, { recursive: true });
  const basePath = path.join(dir, `row-${inputRow.input_row_id}-${safeReason}`);
  const screenshotPath = `${basePath}.jpg`;
  const htmlPath = `${basePath}.html`;

  const screenshot = await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(htmlPath, html, "utf8").catch(() => {});
    await context.emit({
      type: "debug_html",
      index: inputRow.input_row_id,
      html,
      path: htmlPath,
      filename: `aerial_row_${inputRow.input_row_id}_${safeReason}.html`,
    });
  }

  if (screenshot) {
    await context.emit({
      type: "error_screenshot",
      index: inputRow.input_row_id,
      image: screenshot.toString("base64"),
      path: screenshotPath,
    });
  }

  return screenshotPath;
}

async function closePageQuietly(page: Page): Promise<void> {
  await page.close().catch(() => {});
}

function outputRowFromDetails(inputRow: AerialInputRow, details: Record<string, any>, resultIndex: number): Record<string, any> {
  const totalPaid = calculateTotalPaid(details.serviceLines);
  return {
    ...baseOutputRow(inputRow),
    resultIndex: resultIndex + 1,
    claimNumber: details.claimNumber,
    claimStatus: details.claimStatus,
    dateReceived: details.dateReceived,
    rejectDate: details.rejectDate,
    datePaid: details.datePaid,
    checkNumber: details.checkNumber,
    providerDetails: details.providerDetails,
    totalPaid,
    finalStatus: buildAerialFinalStatus(inputRow, details, totalPaid),
    memberId: details.memberId,
    memberName: details.memberName,
    memberBirthDate: details.memberBirthDate,
    memberSex: details.memberSex,
    memberAddress: details.memberAddress,
    memberPhone: details.memberPhone,
    memberHealthPlan: details.memberHealthPlan,
    memberHealthPlanBenefitOption: details.memberHealthPlanBenefitOption,
    memberPcp: details.memberPcp,
    serviceLines: details.serviceLines,
    result: "success",
    notes: "",
    extractedAt: new Date().toISOString(),
  };
}

async function processEyeIconResult(
  page: Page,
  inputRow: AerialInputRow,
  resultIndex: number,
  runId: string,
  state: AerialRunState,
  context: ScraperContext,
  matchDetailServiceDate: boolean,
): Promise<Record<string, any> | null> {
  await context.log({ level: "info", message: `Opening Aerial claim detail popup ${resultIndex + 1}.`, rowIndex: inputRow.input_row_id });
  addAudit(state, runId, inputRow, page, "eye_icon_popup_open_started", "started", `Opening result ${resultIndex + 1}`);
  const detailPopup = await openClaimDetailPopup(page, resultIndex);

  try {
    addAudit(state, runId, inputRow, detailPopup, "detail_extraction_started", "started", `Extracting result ${resultIndex + 1}`);
    const details = await openEobAndExtractDetails(detailPopup);
    if (matchDetailServiceDate) {
      const matchingLines = aerialServiceLinesForDate(details.serviceLines, inputRow.normalized.serviceDate);
      await context.log({ level: "info", message: `Citrus Valley detail: ${details.serviceLines?.length || 0} service line(s), ${matchingLines.length} matched input DOS ${inputRow.normalized.serviceDate}.`, rowIndex: inputRow.input_row_id });
      if (!matchingLines.length) return null;
      details.serviceLines = matchingLines;
    }
    addAudit(state, runId, inputRow, detailPopup, "detail_extraction_completed", "completed", `Extracted result ${resultIndex + 1}`);
    await context.log({ level: "info", message: `Aerial claim status: ${details.claimStatus || "unknown"}.`, rowIndex: inputRow.input_row_id });
    return outputRowFromDetails(inputRow, details, resultIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const snapshotPath = await captureAerialDiagnostics(context, detailPopup, inputRow, "detail-extraction");
    addError(state, runId, inputRow, detailPopup, "detail_extraction", "detail_extraction_failed", message, snapshotPath);
    return {
      ...baseOutputRow(inputRow),
      resultIndex: resultIndex + 1,
      result: "failed",
      notes: `Detail extraction failed: ${message}`,
      extractedAt: new Date().toISOString(),
    };
  } finally {
    await closePageQuietly(detailPopup);
  }
}

async function processCurrentResultsPage(
  page: Page,
  inputRow: AerialInputRow,
  runId: string,
  state: AerialRunState,
  context: ScraperContext,
  matchDetailServiceDate: boolean,
): Promise<Record<string, any>[]> {
  const resultCount = await getOpenRecordCount(page);
  const matchingIndexes = await getMatchingOpenRecordIndexes(page, {
    subscriberNo: inputRow.normalized.subscriberNo,
    serviceDate: inputRow.normalized.serviceDate,
    matchSummaryDate: !matchDetailServiceDate,
  });
  const paginationState = await getPaginationState(page);
  addAudit(
    state,
    runId,
    inputRow,
    page,
    "result_page_detected",
    "completed",
    `Page ${paginationState.currentPage}; found ${resultCount}; matched ${matchingIndexes.length}; next enabled: ${paginationState.nextEnabled}`,
  );

  const rows: Record<string, any>[] = [];
  for (const resultIndex of matchingIndexes) {
    const result = await processEyeIconResult(page, inputRow, resultIndex, runId, state, context, matchDetailServiceDate);
    if (result) rows.push(result);
  }
  return rows;
}

async function processInputRow(
  page: Page,
  inputRow: AerialInputRow,
  runId: string,
  state: AerialRunState,
  context: ScraperContext,
  matchDetailServiceDate: boolean,
): Promise<Record<string, any>[]> {
  await context.log({
    level: "info",
    message: `Searching Aerial row ${inputRow.input_row_id}: ${inputRow.normalized.subscriberNo}, ${inputRow.normalized.serviceDate}.`,
    rowIndex: inputRow.input_row_id,
  });
  addAudit(state, runId, inputRow, page, "row_search_started", "started", "Submitting Claims search");

  await searchClaims(page, {
    subscriberNo: inputRow.normalized.subscriberNo,
    serviceDate: inputRow.normalized.serviceDate,
    startDate: matchDetailServiceDate ? inputRow.normalized.serviceDate : undefined,
    endDate: matchDetailServiceDate ? addDaysToAerialDate(inputRow.normalized.serviceDate, 6) : undefined,
  });

  const resultCount = await getOpenRecordCount(page);
  addAudit(state, runId, inputRow, page, "row_search_completed", "completed", `Found ${resultCount} eye icon(s)`);

  if (resultCount === 0) {
    addAudit(state, runId, inputRow, page, "claims_search_no_data", "completed", "No claim data found in portal.");
    await context.log({
      level: "info",
      message: `No Aerial claim data found for row ${inputRow.input_row_id}.`,
      rowIndex: inputRow.input_row_id,
    });
    return [buildAerialNoDataOutputRow(inputRow)];
  }

  let rows: Record<string, any>[] = [];
  let processedPages = 0;
  const maxResultPages = numberEnv("PORTAL_AERIAL_MAX_RESULT_PAGES", 25);

  while (processedPages < maxResultPages) {
    rows = rows.concat(await processCurrentResultsPage(page, inputRow, runId, state, context, matchDetailServiceDate));
    processedPages += 1;
    if (!(await goToNextResultsPage(page))) break;
  }

  if (!rows.length) {
    addAudit(
      state,
      runId,
      inputRow,
      page,
      "claims_search_no_matching_data",
      "completed",
      "Portal rows were returned, but none matched Member ID and Date of Service.",
    );
    await context.log({
      level: "info",
      message: `No matching Aerial claim data found for row ${inputRow.input_row_id}.`,
      rowIndex: inputRow.input_row_id,
    });
    return [buildAerialNoDataOutputRow(inputRow)];
  }

  return rows;
}

function downloadableFileEvent(filename: string, buffer: Buffer, mimeType: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: buffer.toString("base64"),
    mimeType,
  };
}

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalAerialDate(value: unknown): string {
  const match = String(value || "").match(/\b(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})\b/);
  if (!match) return "";
  const year = match[3]!.length === 2 ? Number(match[3]) + 2000 : Number(match[3]);
  return `${year}-${match[1]!.padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
}

export function aerialServiceLinesForDate(serviceLines: Array<Record<string, any>> | undefined, serviceDate: string): Array<Record<string, any>> {
  const wanted = canonicalAerialDate(serviceDate);
  return (serviceLines || []).filter((line) => canonicalAerialDate(line.serviceDate || line.dateOfService || line.from) === wanted);
}

function addDaysToAerialDate(serviceDate: string, days: number): string {
  const canonical = canonicalAerialDate(serviceDate);
  if (!canonical) return serviceDate;
  const date = new Date(`${canonical}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return `${String(date.getUTCMonth() + 1).padStart(2, "0")}/${String(date.getUTCDate()).padStart(2, "0")}/${date.getUTCFullYear()}`;
}

export function shouldDownloadAerialRunLog(errorRows: Record<string, unknown>[], fatalError = false): boolean {
  return fatalError || errorRows.length > 0;
}

async function emitAerialArtifacts(
  context: ScraperContext,
  state: AerialRunState,
  options: { fatalError?: boolean } = {},
): Promise<void> {
  const workbookBuffer = createAerialOutputWorkbookBuffer(state.outputRows, {
    errorRows: state.errorRows,
    auditRows: state.auditRows,
  });
  await context.emit(downloadableFileEvent("aerial_output.xlsx", workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));

  const logContent = formatAerialLog(state.auditRows, state.errorRows);
  const logPath = await saveAerialLogFile(context.jobId, logContent);
  await context.log({ level: "info", message: `Aerial log saved: ${logPath}` });
  if (shouldDownloadAerialRunLog(state.errorRows, options.fatalError)) {
    await context.emit(downloadableFileEvent("aerial-run.log", Buffer.from(logContent, "utf8"), "text/plain"));
  }
}

export async function runAerialClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  loadAerialEnvironment();
  const state: AerialRunState = { outputRows: [], errorRows: [], auditRows: [] };
  const runId = createRunId();
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    const input: AerialInput = await parseAerialInput(formData);
    const subportalLabel = AERIAL_SUBPORTAL_LABELS[input.subportal];
    const rows = readAerialInputWorkbookFromBuffer(input.inputWorkbookBuffer);
    const usesGroupedCredentials = input.credentialGroups.length > 0;
    const missingGroupRows = usesGroupedCredentials ? rows.filter((row) => row.validation_status === "valid" && !row.Group.trim()) : [];
    const validRows = rows.filter((row) => row.validation_status === "valid" && !missingGroupRows.includes(row));
    await context.log({ level: "info", message: `Aerial / ${subportalLabel} input loaded: ${rows.length} row(s), ${validRows.length} valid.` });
    await context.emit({ type: "progress", completed: 0, total: rows.length });

    let completed = 0;
    for (const invalidRow of [...rows.filter((row) => row.validation_status !== "valid"), ...missingGroupRows]) {
      const validationMessage = invalidRow.validation_message || (usesGroupedCredentials && !invalidRow.Group.trim() ? `Missing Group for ${subportalLabel} credential routing.` : "Input validation failed.");
      addError(state, runId, invalidRow, page ?? null, "validation", "input_validation_failed", validationMessage);
      state.outputRows.push({ ...baseOutputRow(invalidRow), result: "failed", notes: validationMessage });
      completed += 1;
      await context.emit({ type: "progress", completed, total: rows.length });
    }

    const normalizeGroup = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
    const batches = usesGroupedCredentials
      ? input.credentialGroups.map((entry) => ({ ...entry, rows: validRows.filter((row) => normalizeGroup(row.Group) === normalizeGroup(entry.group)) }))
      : [{ group: "PMG", credentials: input.credentials, rows: validRows }];

    for (const batch of batches.filter((entry) => entry.rows.length)) {
      try {
        await context.log({ level: "info", message: `Aerial / ${subportalLabel}: logging in for Group ${batch.group} (${batch.rows.length} row(s)).` });
        const browserSession = await launchAerialBrowser((message) => context.log({ level: "info", message }));
        browser = browserSession.browser;
        page = await browserSession.context.newPage();
        addAudit(state, runId, null, page, "job_started", "started", `Aerial / ${subportalLabel} / Group ${batch.group} automation started`);
        await loginToAerial(page, batch.credentials);
        addAudit(state, runId, null, page, "login_completed", "completed", `Login verified for Group ${batch.group}`);
        await goToClaims(page, batch.credentials);
        await verifyClaimsSearchForm(page);
        addAudit(state, runId, null, page, "claims_navigation_completed", "completed", `Claims search form verified for Group ${batch.group}`);

        for (const inputRow of batch.rows) {
          try {
            addAudit(state, runId, inputRow, page, "row_started", "started", "Row processing started");
            const rowOutputRows = await processInputRow(page, inputRow, runId, state, context, input.subportal === "citrus-valley");
            state.outputRows.push(...rowOutputRows);
            addAudit(state, runId, inputRow, page, "row_completed", "completed", "Row processing completed");
          } catch (error) {
            const message = errorMessage(error);
            const snapshotPath = await captureAerialDiagnostics(context, page, inputRow, "row-processing");
            addError(state, runId, inputRow, page, "row_processing", "row_processing_failed", message, snapshotPath);
            state.outputRows.push({ ...baseOutputRow(inputRow), result: "failed", notes: `Row processing failed: ${message}` });
          }
          completed += 1;
          await context.emit({ type: "progress", completed, total: rows.length });
        }
      } finally {
        await closeAutomationResources({ browser, page, log: (message) => context.log({ level: "info", message }) });
        browser = undefined;
        page = undefined;
      }
    }

    await emitAerialArtifacts(context, state);
    if (state.errorRows.length > 0) {
      await context.emit({
        type: "warning",
        message: `Aerial completed with ${state.errorRows.length} row-level error(s). Download aerial-run.log for details.`,
      });
    }
    await context.emit({ type: "done" });
  } catch (error) {
    const message = errorMessage(error);
    addAudit(state, runId, null, page ?? null, "job_failed", "failed", message);
    addError(state, runId, null, page ?? null, "aerial_run", "fatal_run_error", message);
    await context.log({ level: "error", message: `Aerial run failed: ${message}` });
    await emitAerialArtifacts(context, state, { fatalError: true }).catch((artifactError) => {
      void context.log({ level: "error", message: `Failed to create Aerial partial output/log: ${errorMessage(artifactError)}` });
    });
    await context.emit({ type: "error", message });
    await context.emit({ type: "done" });
  } finally {
    await closeAutomationResources({
      browser,
      page,
      log: (message) => context.log({ level: "info", message }),
    });
  }
}
