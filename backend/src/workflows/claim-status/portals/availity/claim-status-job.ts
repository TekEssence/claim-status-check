import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ScraperContext } from "../../types";
import { launchAvailityBrowser } from "./browser";
import { parseAvailityInput, readAvailityPayerMapping } from "./input";
import { createAvailityOutputWorkbookBuffer } from "./output-writer";
import { getMfaConfigForProject, getOrganizationForRow, getProviderOrderForRow, readAvailityProviderMapping } from "./project-config";
import { applyProjectOutputStrategy } from "./project-output";
import type { AvailityAuditRow, AvailityErrorRow, AvailityInputRow, AvailityOutputRow, AvailityProviderMapping } from "./types";

const require = createRequire(import.meta.url);
const { submitLogin } = require("./pages/login.page.js");
const { handleMfa } = require("./pages/mfa.page.js");
const { acceptCookiesIfPresent, getClaimStatusFrame, logoutIfPresent, openClaimStatus } = require("./pages/navigation.page.js");
const { selectPayer } = require("./pages/claim-status-member.page.js");
const { validateRow } = require("./services/row-validator.js");
const { renderFailedSummary } = require("./services/summary-renderer.js");
const { getWorkflowForPayer } = require("./payers/registry.js");
const availityLogger = require("./utils/logger.js");

const ROW_PROCESS_MAX_ATTEMPTS = 3;
const MEDREVENU_REQUIRED_FIELDS = ["Payer Name", "Service Date", "Charges"];

function nowIso(): string {
  return new Date().toISOString();
}

function createRunId(): string {
  return `availity_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

function createAvailityOutputFilename(partial = false): string {
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return partial ? `availity_claimstatus_partial_${suffix}.xlsx` : `availity_claimstatus_${suffix}.xlsx`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function friendlyAvailityError(error: unknown): string {
  const message = errorMessage(error);
  if (/Availity browser could not start|browserType\.launch|Target page, context or browser has been closed/i.test(message)) {
    return `Availity browser failed to start. Install Playwright Chromium with "npx playwright install chromium", or set PORTAL_AVAILITY_BROWSER_CHANNEL=chrome/msedge if Chrome or Edge is installed. Details: ${message.split(/\r?\n/)[0]}`;
  }
  if (/Cannot read properties of undefined \(reading 'toLowerCase'\)/i.test(message)) {
    return "Availity validation failed because a required text value was missing. Check the claim Excel headers/values and the payer mapping workbook.";
  }
  if (/Cannot read properties of undefined/i.test(message)) {
    return `Availity automation received a missing value where text was expected. ${message}`;
  }
  return message;
}

function safePageUrl(page: Page | null): string {
  try {
    return page && !page.isClosed() ? page.url() : "";
  } catch {
    return "";
  }
}

function buildBaseOutput(row: AvailityInputRow): AvailityOutputRow {
  return {
    input_row_id: row.input_row_id,
    ...row.data,
    bot_updated_claim_status: "",
    bot_updated_time: "",
    bot_search_source_tab: "",
    bot_match_count: "",
    bot_overall_result: "",
    bot_notes: "",
  };
}

function buildInputAuditRow(row: AvailityInputRow, validation: { validation_status: string; validation_message: string }): AvailityOutputRow {
  return {
    input_row_id: row.input_row_id,
    ...row.data,
    validation_status: validation.validation_status,
    validation_message: validation.validation_message,
  };
}

function markFailure(outputRow: AvailityOutputRow, message: string, result = "failed", notes = ""): void {
  outputRow.bot_updated_claim_status = renderFailedSummary(message);
  outputRow.bot_updated_time = nowIso();
  outputRow.bot_overall_result = result;
  outputRow.bot_notes = notes || message;
}

function addError(errorRows: AvailityErrorRow[], runId: string, row: AvailityInputRow, fields: Partial<AvailityErrorRow>): void {
  errorRows.push({
    run_id: runId,
    input_row_id: row.input_row_id,
    payer_name: row.data["Payer Name"] || "",
    claim_no: row.data["Claim No"] || "",
    service_date: row.data["Service Date"] || "",
    charges: row.data.Charges || "",
    search_source_tab: fields.search_source_tab || "",
    failure_stage: fields.failure_stage || "",
    failure_reason: fields.failure_reason || "",
    current_url: fields.current_url || "",
    needs_manual_review: fields.needs_manual_review || "yes",
  });
}

function addAudit(auditRows: AvailityAuditRow[], runId: string, row: AvailityInputRow | null, step: string, status: string, message: string, startedAt = Date.now(), retryCount = 0): void {
  auditRows.push({
    run_id: runId,
    timestamp: nowIso(),
    input_row_id: row ? row.input_row_id : "",
    payer_name: row ? row.data["Payer Name"] || "" : "",
    claim_no: row ? row.data["Claim No"] || "" : "",
    step,
    status,
    duration_ms: Date.now() - startedAt,
    retry_count: retryCount,
    message,
  });
}

function isClosedPageError(message: string): boolean {
  return /Target page, context or browser has been closed|Browser page was closed|page was closed|context.*closed|browser.*closed/i.test(message);
}

function isSubmitNoResponseError(message: string): boolean {
  return /submit did not produce results, no-results message, or validation response/i.test(message);
}

function isRecoverableRowError(message: string): boolean {
  return isClosedPageError(message) || isSubmitNoResponseError(message);
}

function downloadableFileEvent(filename: string, buffer: Buffer, mimeType: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: buffer.toString("base64"),
    mimeType,
  };
}

function outputSnapshotEvent(filename: string, fields: { buffer?: Buffer; path?: string }, completed: number, total: number, mimeType: string): Record<string, unknown> {
  return {
    type: "output_snapshot",
    filename,
    ...(fields.buffer ? { base64: fields.buffer.toString("base64") } : {}),
    ...(fields.path ? { path: fields.path } : {}),
    completed,
    total,
    mimeType,
  };
}

function rowProgressEvent(row: AvailityInputRow, current: number, total: number, stage: string): Record<string, unknown> {
  return {
    type: "row_progress",
    current,
    currentRow: row.input_row_id,
    totalRows: total,
    total,
    completed: current - 1,
    payerName: row.data["Payer Name"] || "Unknown payer",
    stage,
  };
}


function legacyLevelToContextLevel(level: string): "debug" | "info" | "warn" | "error" {
  if (level === "ERROR") return "error";
  if (level === "WARN") return "warn";
  return "info";
}

async function selectAutocompleteValue(scope: any, inputLocator: any, value: string): Promise<void> {
  await inputLocator.waitFor({ state: "visible", timeout: 30000 });
  await inputLocator.scrollIntoViewIfNeeded().catch(() => {});
  await inputLocator.click({ force: true });
  await inputLocator.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await inputLocator.press("Backspace").catch(() => {});
  await inputLocator.fill(value);
  await scope.page().waitForTimeout(600).catch(() => {});

  const option = scope.getByText(value, { exact: true }).last();
  const clickedExactOption = await scope.evaluate((expected: string) => {
    const normalize = (text: unknown) => String(text || "").replace(/\s+/g, " ").trim();
    const candidates = Array.from(document.querySelectorAll("[role='option'], [id*='option'], .Select-option, .select__option"));
    const match = candidates.find((element) => normalize(element.textContent) === normalize(expected));
    if (!match) return false;
    match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    (match as HTMLElement).click();
    return true;
  }, value).catch(() => false);

  if (clickedExactOption) {
    await scope.page().waitForTimeout(500).catch(() => {});
  } else if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
    await option.click();
  } else {
    await inputLocator.press("Enter").catch(() => {});
  }

  await scope.page().waitForTimeout(500).catch(() => {});
}

async function firstVisibleLocator(locators: any[], timeoutMs = 5000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const locator of locators) {
      if (await locator.isVisible({ timeout: 500 }).catch(() => false)) {
        return locator;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error("No visible Availity input was found for the requested selector group.");
}

function normalizeUiText(value: unknown): string {
  return String(value || "").replace(/\s+/g, " ").trim();
}

async function getOrganizationSelectedText(frame: any): Promise<string> {
  return normalizeUiText(await frame.evaluate(() => {
    const isVisible = (element: Element) => {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const selectedValues = Array.from(document.querySelectorAll(
      "#orgSelect .organization-select__single-value, .organization-select__single-value"
    ));
    return selectedValues.find(isVisible)?.textContent || "";
  }).catch(() => ""));
}

async function clickExactOrganizationOption(frame: any, organization: string): Promise<boolean> {
  return Boolean(await frame.evaluate((expected: string) => {
    const normalize = (text: unknown) => String(text || "").replace(/\s+/g, " ").trim();
    const expectedText = normalize(expected);
    const candidates = Array.from(document.querySelectorAll(
      "[role='option'], [id^='react-select-'][id*='-option-'], .organization-select__option"
    ));
    const match = candidates.find((element) => normalize(element.textContent) === expectedText);
    if (!match) return false;

    match.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
    match.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
    (match as HTMLElement).click();
    return true;
  }, organization).catch(() => false));
}

async function selectOrganization(page: Page, organization: string): Promise<void> {
  let frame = await getClaimStatusFrame(page);
  let organizationContainer = await firstVisibleLocator([
    frame.locator("#orgSelect").first(),
    frame.locator(".organization-select__control").first(),
    frame.locator("label").filter({ hasText: /^Organization$/ }).first()
      .locator("xpath=following::*[contains(@class,'organization-select__control') or @id='orgSelect'][1]"),
  ], 15000).catch(async () => {
    await openClaimStatus(page, { forceOpen: true });
    frame = await getClaimStatusFrame(page);
    return firstVisibleLocator([
      frame.locator("#orgSelect").first(),
      frame.locator(".organization-select__control").first(),
      frame.locator("label").filter({ hasText: /^Organization$/ }).first()
        .locator("xpath=following::*[contains(@class,'organization-select__control') or @id='orgSelect'][1]"),
    ], 30000);
  });
  const currentSelectedText = await getOrganizationSelectedText(frame);
  if (currentSelectedText === organization) {
    return;
  }

  await organizationContainer.click({ force: true }).catch(() => {});
  const organizationLabelInput = frame.locator("label").filter({ hasText: /^Organization$/ }).first()
    .locator("xpath=following::input[@role='combobox'][1]");
  const organizationInput = await firstVisibleLocator([
    organizationContainer.locator("input[role='combobox']").first(),
    frame.locator("input#organization[role='combobox'], input#organization").first(),
    frame.locator("input#orgSelect[role='combobox'], input#orgSelect").first(),
    organizationLabelInput,
  ], 15000);
  await organizationInput.waitFor({ state: "visible", timeout: 30000 });
  await organizationInput.scrollIntoViewIfNeeded().catch(() => {});
  await organizationInput.click({ force: true });
  await organizationInput.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => {});
  await organizationInput.press("Backspace").catch(() => {});
  await organizationInput.fill(organization);
  await page.waitForTimeout(700).catch(() => {});

  if (!(await clickExactOrganizationOption(frame, organization))) {
    const option = frame.getByText(organization, { exact: true }).last();
    if (await option.isVisible({ timeout: 5000 }).catch(() => false)) {
      await option.click({ force: true });
    } else {
      await organizationInput.press("Enter").catch(() => {});
    }
  }

  await page.waitForTimeout(700).catch(() => {});
  const selectedValue = await getOrganizationSelectedText(frame);
  if (selectedValue !== organization) {
    throw new Error(`Availity organization "${organization}" was not selected. Current value: "${selectedValue || currentSelectedText || "(blank)"}".`);
  }
}

async function loginToAvaility(page: Page, input: Awaited<ReturnType<typeof parseAvailityInput>>, context: ScraperContext, log: (message: string) => Promise<void>): Promise<void> {
  await log("Opening Availity login page.");
  await page.goto(input.credentials.loginUrl, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("networkidle").catch(() => {});
  await submitLogin(page, input.credentials.username, input.credentials.password);
  await handleMfa(page, input.credentials.totpSecret, 2, 0, 20, getMfaConfigForProject(input.projectId));

  if (input.credentials.successUrlFragment) {
    await page.waitForURL(`**${input.credentials.successUrlFragment}**`, { timeout: 30000 }).catch(() => {});
  }

  await context.log({ level: "info", message: "Availity login completed." });
}

async function initializeSession(input: Awaited<ReturnType<typeof parseAvailityInput>>, context: ScraperContext, log: (message: string) => Promise<void>) {
  const session = await launchAvailityBrowser(log);
  const page = session.context.pages()[0] ?? await session.context.newPage();
  page.setDefaultTimeout(Number(process.env.PORTAL_AVAILITY_DEFAULT_TIMEOUT_MS || 30000));
  page.setDefaultNavigationTimeout(Number(process.env.PORTAL_AVAILITY_NAVIGATION_TIMEOUT_MS || 45000));
  await loginToAvaility(page, input, context, log);
  await acceptCookiesIfPresent(page, 10000);
  await openClaimStatus(page);
  await log("Availity Claim Status page opened.");
  return { ...session, page };
}

async function processValidRow(
  page: Page,
  row: AvailityInputRow,
  mappedPayerName: string,
  automationState: { selectedOrganization: string; selectedPayer: string },
  options: { projectId: string; providerMappings: AvailityProviderMapping[] },
) {
  if (!mappedPayerName?.trim()) {
    throw new Error(`Payer mapping is blank for "${row.data["Payer Name"] || "unknown payer"}". Update backend/src/workflows/claim-status/portals/availity/config/Payer_mapping_ava.xlsx.`);
  }

  const organization = getOrganizationForRow(options.projectId, row);
  if (organization && automationState.selectedOrganization !== organization) {
    await selectOrganization(page, organization);
    automationState.selectedOrganization = organization;
    automationState.selectedPayer = "";
  }

  if (automationState.selectedPayer !== mappedPayerName) {
    await selectPayer(page, mappedPayerName);
    automationState.selectedPayer = mappedPayerName;
  }

  const workflow = getWorkflowForPayer({
    inputPayerName: row.data["Payer Name"] || "",
    mappedPortalPayerName: mappedPayerName,
  });
  const providerOrder = getProviderOrderForRow(options.projectId, row, options.providerMappings);
  return workflow.processClaim(page, row, {
    projectId: options.projectId,
    providerOrder,
  });
}

export async function runAvailityClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const runId = createRunId();
  const input = await parseAvailityInput(formData);
  const inputSheetRows: AvailityOutputRow[] = [];
  const outputRows: AvailityOutputRow[] = [];
  const errorRows: AvailityErrorRow[] = [];
  const auditRows: AvailityAuditRow[] = [];
  const automationState = { selectedOrganization: "", selectedPayer: "" };
  const payerMapping = await readAvailityPayerMapping(input.projectId);
  const providerMappings = await readAvailityProviderMapping();
  let session: Awaited<ReturnType<typeof initializeSession>> | null = null;
  let activeRow: AvailityInputRow | null = null;
  let outputWorkbookEmitted = false;

  const log = async (message: string) => context.log({ level: "info", message });
  availityLogger.setLogSink((entry: { level: string; message: string; line: string }) => {
    void context.log({
      level: legacyLevelToContextLevel(entry.level),
      message: entry.line,
    });
  });
  await log(`Availity input loaded: ${input.inputRows.length} row(s). Project: ${input.projectId}. Available payers: Aetna, Anthem-CA, Blue Cross Blue Shield, Wellpoint, Wellcare, Humana, Central Health Medicare Plan, Health Net, Molina, Providence Health Plan, Scan Health, TRIWEST-TRICARE, TRIWEST-VA CCN.`);
  await context.emit({ type: "progress", completed: 0, total: input.inputRows.length });

  const emitOutputWorkbook = async (partial: boolean): Promise<void> => {
    const workbookBuffer = await createAvailityOutputWorkbookBuffer({
      inputHeaders: input.inputHeaders,
      inputRows: inputSheetRows,
      outputRows,
      errorRows,
      auditRows,
    });
    await context.emit(downloadableFileEvent(createAvailityOutputFilename(partial), workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    outputWorkbookEmitted = true;
  };

  const emitOutputSnapshot = async (completed: number): Promise<void> => {
    const workbookBuffer = await createAvailityOutputWorkbookBuffer({
      inputHeaders: input.inputHeaders,
      inputRows: inputSheetRows,
      outputRows,
      errorRows,
      auditRows,
    });
    const snapshotDir = path.join(os.tmpdir(), "availity-output-snapshots", runId);
    fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, "availity_output_snapshot.xlsx");
    fs.writeFileSync(snapshotPath, workbookBuffer);
    const shouldSendWorkbookToBrowser = completed % 10 === 0 || completed === input.inputRows.length;
    await context.emit(outputSnapshotEvent(
      "availity_output_snapshot.xlsx",
      shouldSendWorkbookToBrowser ? { buffer: workbookBuffer, path: snapshotPath } : { path: snapshotPath },
      completed,
      input.inputRows.length,
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ));
  };

  try {
    session = await initializeSession(input, context, log);

    for (let index = 0; index < input.inputRows.length; index += 1) {
      if (context.isCancelled?.()) {
        await context.emit({ type: "cancelled", message: "Availity processing cancelled." });
        break;
      }

      if (session.page.isClosed()) {
        await log("Availity page closed before next row. Restarting browser session.");
        await session.browser.close().catch(() => {});
        session = await initializeSession(input, context, log);
        automationState.selectedOrganization = "";
        automationState.selectedPayer = "";
      }

      const row = input.inputRows[index];
      activeRow = row;
      const startedAt = Date.now();
      const outputRow = buildBaseOutput(row);
      await context.emit(rowProgressEvent(row, index + 1, input.inputRows.length, "started"));
      let validation: { isValid: boolean; validation_status: string; validation_message: string; mappedPayerName: string };
      try {
        validation = validateRow(
          row,
          payerMapping,
          input.projectId === "medrevenu" ? { requiredFields: MEDREVENU_REQUIRED_FIELDS } : undefined,
        );
      } catch (error) {
        const message = friendlyAvailityError(error);
        validation = {
          isValid: false,
          validation_status: "invalid",
          validation_message: message,
          mappedPayerName: "",
        };
      }
      inputSheetRows.push(buildInputAuditRow(row, validation));
      await log(`Availity row ${row.input_row_id}/${input.inputRows.length}: ${row.data["Payer Name"] || "Unknown payer"}.`);

      if (!validation.isValid) {
        markFailure(outputRow, validation.validation_message);
        outputRows.push(outputRow);
        addError(errorRows, runId, row, {
          failure_stage: "validation",
          failure_reason: validation.validation_message,
          current_url: safePageUrl(session.page),
        });
        addAudit(auditRows, runId, row, "validation", "failed", validation.validation_message, startedAt);
        await context.emit({ type: "progress", completed: index + 1, total: input.inputRows.length });
        await emitOutputSnapshot(index + 1);
        activeRow = null;
        continue;
      }

      let rowHandled = false;
      let lastRowErrorMessage = "";
      for (let rowAttempt = 1; rowAttempt <= ROW_PROCESS_MAX_ATTEMPTS && !rowHandled; rowAttempt += 1) {
        try {
          await context.emit(rowProgressEvent(row, index + 1, input.inputRows.length, `attempt ${rowAttempt}`));
          const result = await processValidRow(session.page, row, validation.mappedPayerName, automationState, {
            projectId: input.projectId,
            providerMappings,
          });
          const projectOutputRows = applyProjectOutputStrategy({
            projectId: input.projectId,
            row,
            outputRow,
            result,
            timestamp: nowIso(),
          });
          outputRows.push(...projectOutputRows);

          const projectOutputFailed = projectOutputRows.some((projectOutputRow) => projectOutputRow.bot_overall_result && projectOutputRow.bot_overall_result !== "success");
          if (result.status !== "success" || projectOutputFailed) {
            addError(errorRows, runId, row, {
              search_source_tab: result.sourceTab || "",
              failure_stage: "claim_status_search_results",
              failure_reason: String(projectOutputRows.find((projectOutputRow) => projectOutputRow.bot_overall_result !== "success")?.bot_notes || result.notes || result.status),
              current_url: safePageUrl(session.page),
            });
          }

          addAudit(auditRows, runId, row, "claim_status_search", result.status || "completed", result.notes || "Row processed", startedAt);
          rowHandled = true;
        } catch (error) {
          const message = friendlyAvailityError(error);
          lastRowErrorMessage = message;
          await context.log({ level: "warn", message: `Availity row ${row.input_row_id} attempt ${rowAttempt} failed: ${message}` });

          if (rowAttempt < ROW_PROCESS_MAX_ATTEMPTS && isRecoverableRowError(message)) {
            automationState.selectedPayer = "";
            if (isClosedPageError(message) || rowAttempt >= 2) {
              await session.browser.close().catch(() => {});
              session = await initializeSession(input, context, log);
              automationState.selectedOrganization = "";
              automationState.selectedPayer = "";
            } else {
              await openClaimStatus(session.page, { forceOpen: true });
              automationState.selectedOrganization = "";
              automationState.selectedPayer = "";
            }
            addAudit(auditRows, runId, row, "row_recovery", "recovered", message, startedAt, rowAttempt);
            continue;
          }

          markFailure(outputRow, message);
          outputRows.push(outputRow);
          addError(errorRows, runId, row, {
            search_source_tab: "Member/HIPAA",
            failure_stage: "row_processing",
            failure_reason: message,
            current_url: safePageUrl(session.page),
          });
          addAudit(auditRows, runId, row, "row_processing", "failed", message, startedAt);
          rowHandled = true;
        }
      }

      if (!rowHandled && lastRowErrorMessage) {
        markFailure(outputRow, lastRowErrorMessage);
        outputRows.push(outputRow);
      }

      await context.emit({ type: "progress", completed: index + 1, total: input.inputRows.length });
      await emitOutputSnapshot(index + 1);
      activeRow = null;
    }

    await emitOutputWorkbook(false);

    if (errorRows.length) {
      await context.emit({
        type: "warning",
        message: `Availity completed with ${errorRows.length} error row(s).`,
      });
    }
  } catch (error) {
    const message = friendlyAvailityError(error);
    if (activeRow && !outputRows.some((row) => row.input_row_id === activeRow?.input_row_id)) {
      const outputRow = buildBaseOutput(activeRow);
      markFailure(outputRow, message, "failed", "Fatal Availity job error occurred while this row was active.");
      outputRows.push(outputRow);
      addError(errorRows, runId, activeRow, {
        search_source_tab: "Member/HIPAA",
        failure_stage: "fatal_job_error",
        failure_reason: message,
        current_url: safePageUrl(session?.page || null),
      });
      addAudit(auditRows, runId, activeRow, "fatal_job_error", "failed", message);
    }
    if (!outputWorkbookEmitted && (outputRows.length || inputSheetRows.length || errorRows.length || auditRows.length)) {
      await context.log({ level: "warn", message: "Availity job stopped before normal completion. Emitting partial output workbook." });
      try {
        await emitOutputWorkbook(true);
      } catch (partialOutputError) {
        await context.log({ level: "error", message: `Failed to emit Availity partial output workbook: ${friendlyAvailityError(partialOutputError)}` });
      }
    }
    await context.emit({ type: "error", message });
  } finally {
    availityLogger.setLogSink(null);
    if (session?.page && !session.page.isClosed()) {
      await logoutIfPresent(session.page).catch(() => {});
    }
    await session?.browser.close().catch(() => {});
    await context.emit({ type: "done" });
  }
}
