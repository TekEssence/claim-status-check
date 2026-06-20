import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, Page } from "playwright-core";
import type { ScraperContext } from "../types";
import { launchAerialBrowser } from "./browser";
import { parseAerialInput, type AerialInput } from "./input";
import { createAerialOutputWorkbookBuffer, readAerialInputWorkbookFromBuffer, type AerialInputRow } from "./workbook";
import { formatAerialLog, saveAerialLogFile } from "./log-file";
import { loadAerialEnvironment } from "./env";

type AerialLoginModule = {
  loginToAerial(page: Page, config: AerialRuntimeConfig): Promise<void>;
  goToClaims(page: Page, config: AerialRuntimeConfig): Promise<void>;
};

type AerialClaimsPageModule = {
  verifyClaimsSearchForm(page: Page): Promise<void>;
  searchClaims(page: Page, search: { subscriberNo: string; serviceDate: string }): Promise<void>;
  getOpenRecordCount(page: Page): Promise<number>;
  getMatchingOpenRecordIndexes(page: Page, criteria: { subscriberNo: string; serviceDate: string }): Promise<number[]>;
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

const { loginToAerial, goToClaims } = require("./legacy/aerial-login.js") as AerialLoginModule;
const {
  verifyClaimsSearchForm,
  searchClaims,
  getOpenRecordCount,
  getMatchingOpenRecordIndexes,
  openClaimDetailPopup,
  getPaginationState,
  goToNextResultsPage,
} = require("./legacy/claims-page.js") as AerialClaimsPageModule;
const { openEobAndExtractDetails } = require("./legacy/claim-detail-page.js") as AerialDetailModule;

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
    subscriberNo: inputRow.normalized.subscriberNo,
    serviceDate: inputRow.normalized.serviceDate,
    claimStatus: "",
    result: "failed",
    notes: "",
    extractedAt: new Date().toISOString(),
  };
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
  inputRow: AerialInputRow,
  page: Page | null,
  failureStage: string,
  failureReason: string,
  humanMessage: string,
  snapshotPath = "",
): void {
  state.errorRows.push({
    run_id: runId,
    timestamp: new Date().toISOString(),
    input_row_id: inputRow.input_row_id,
    subscriber_no: inputRow.normalized?.subscriberNo ?? inputRow["Subscriber No"],
    service_date: inputRow.normalized?.serviceDate ?? inputRow["Service Date"],
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
  const dir = path.join(process.cwd(), "data", "screenshots", "aerial", context.jobId);
  await fs.mkdir(dir, { recursive: true });
  const basePath = path.join(dir, `row-${inputRow.input_row_id}-${safeReason}`);
  const screenshotPath = `${basePath}.jpg`;
  const htmlPath = `${basePath}.html`;

  const screenshot = await page.screenshot({ path: screenshotPath, type: "jpeg", quality: 80, fullPage: true }).catch(() => null);
  const html = await page.content().catch(() => "");
  if (html) {
    await fs.writeFile(htmlPath, html, "utf8").catch(() => {});
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
): Promise<Record<string, any>> {
  await context.log({ level: "info", message: `Opening Aerial claim detail popup ${resultIndex + 1}.`, rowIndex: inputRow.input_row_id });
  addAudit(state, runId, inputRow, page, "eye_icon_popup_open_started", "started", `Opening result ${resultIndex + 1}`);
  const detailPopup = await openClaimDetailPopup(page, resultIndex);

  try {
    addAudit(state, runId, inputRow, detailPopup, "detail_extraction_started", "started", `Extracting result ${resultIndex + 1}`);
    const details = await openEobAndExtractDetails(detailPopup);
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
): Promise<Record<string, any>[]> {
  const resultCount = await getOpenRecordCount(page);
  const matchingIndexes = await getMatchingOpenRecordIndexes(page, {
    subscriberNo: inputRow.normalized.subscriberNo,
    serviceDate: inputRow.normalized.serviceDate,
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
    rows.push(await processEyeIconResult(page, inputRow, resultIndex, runId, state, context));
  }
  return rows;
}

async function processInputRow(
  page: Page,
  inputRow: AerialInputRow,
  runId: string,
  state: AerialRunState,
  context: ScraperContext,
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
  });

  const resultCount = await getOpenRecordCount(page);
  addAudit(state, runId, inputRow, page, "row_search_completed", "completed", `Found ${resultCount} eye icon(s)`);

  if (resultCount === 0) {
    const snapshotPath = await captureAerialDiagnostics(context, page, inputRow, "no-claim-results");
    addError(state, runId, inputRow, page, "claims_search", "no_claims_or_no_eye_icons_found", "No open-record eye icons found after search.", snapshotPath);
    return [{ ...baseOutputRow(inputRow), result: "failed", notes: "No open-record eye icons found after search.", extractedAt: new Date().toISOString() }];
  }

  let rows: Record<string, any>[] = [];
  let processedPages = 0;
  const maxResultPages = numberEnv("PORTAL_AERIAL_MAX_RESULT_PAGES", 25);

  while (processedPages < maxResultPages) {
    rows = rows.concat(await processCurrentResultsPage(page, inputRow, runId, state, context));
    processedPages += 1;
    if (!(await goToNextResultsPage(page))) break;
  }

  if (!rows.length) {
    const snapshotPath = await captureAerialDiagnostics(context, page, inputRow, "no-matching-results");
    addError(state, runId, inputRow, page, "claims_search", "no_matching_result_rows", "Result rows were returned, but none matched Member ID and Date of Service.", snapshotPath);
    return [{ ...baseOutputRow(inputRow), result: "failed", notes: "No result rows matched Member ID and Date of Service.", extractedAt: new Date().toISOString() }];
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

async function emitAerialArtifacts(
  context: ScraperContext,
  state: AerialRunState,
): Promise<void> {
  const workbookBuffer = createAerialOutputWorkbookBuffer(state.outputRows, {
    errorRows: state.errorRows,
    auditRows: state.auditRows,
  });
  await context.emit(downloadableFileEvent("aerial_output.xlsx", workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));

  const logContent = formatAerialLog(state.auditRows, state.errorRows);
  const logPath = await saveAerialLogFile(context.jobId, logContent);
  await context.log({ level: "info", message: `Aerial log saved: ${logPath}` });
  await context.emit(downloadableFileEvent("aerial-run.log", Buffer.from(logContent, "utf8"), "text/plain"));
}

export async function runAerialClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  loadAerialEnvironment();
  const input: AerialInput = await parseAerialInput(formData);
  const state: AerialRunState = { outputRows: [], errorRows: [], auditRows: [] };
  const runId = createRunId();
  let browser: Browser | undefined;
  let page: Page | undefined;

  try {
    const rows = readAerialInputWorkbookFromBuffer(input.inputWorkbookBuffer);
    const validRows = rows.filter((row) => row.validation_status === "valid");
    await context.log({ level: "info", message: `Aerial input loaded: ${rows.length} row(s), ${validRows.length} valid.` });
    await context.emit({ type: "progress", completed: 0, total: rows.length });

    const browserSession = await launchAerialBrowser((message) => context.log({ level: "info", message }));
    browser = browserSession.browser;
    page = await browserSession.context.newPage();

    addAudit(state, runId, null, page, "job_started", "started", "Aerial automation started");
    await loginToAerial(page, input.credentials);
    addAudit(state, runId, null, page, "login_completed", "completed", "Login verified");
    await goToClaims(page, input.credentials);
    await verifyClaimsSearchForm(page);
    addAudit(state, runId, null, page, "claims_navigation_completed", "completed", "Claims search form verified");

    let completed = 0;
    for (const invalidRow of rows.filter((row) => row.validation_status !== "valid")) {
      addError(state, runId, invalidRow, page, "validation", "input_validation_failed", invalidRow.validation_message || "Input validation failed.");
      state.outputRows.push({ ...baseOutputRow(invalidRow), result: "failed", notes: invalidRow.validation_message || "Input validation failed." });
      completed += 1;
      await context.emit({ type: "progress", completed, total: rows.length });
    }

    for (const inputRow of validRows) {
      try {
        addAudit(state, runId, inputRow, page, "row_started", "started", "Row processing started");
        const rowOutputRows = await processInputRow(page, inputRow, runId, state, context);
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
    await context.log({ level: "error", message: `Aerial run failed: ${message}` });
    await emitAerialArtifacts(context, state).catch((artifactError) => {
      void context.log({ level: "error", message: `Failed to create Aerial partial output/log: ${errorMessage(artifactError)}` });
    });
    await context.emit({ type: "error", message });
    await context.emit({ type: "done" });
  } finally {
    await browser?.close().catch(() => {});
  }
}
