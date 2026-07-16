import type { Browser, BrowserContext, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { ScraperContext } from "../../types";
import { launchAstronaBrowser } from "./browser";
import { parseAstronaInput, readAstronaCredentials, readAstronaInputRows, routeAstronaRows } from "./input";
import { astronaClaimDobMatches, astronaClaimNameMatches, astronaMemberNameSearchCandidates, astronaServiceLinesForDosAndCpt, astronaShowsNoClaimResults, extractAstronaClaimDetails, getAstronaClaimCount, getAstronaClaimNumbersForRow, goToAstronaClaims, loginToAstrona, openAstronaClaimByNumber, returnToAstronaResults, searchAstronaClaims, selectAstronaProviderPortal, signOutAstrona } from "./portal";
import type { AstronaClaimDetails, AstronaInputRow } from "./types";
import { astronaOutputRows, createAstronaWorkbook } from "./workbook";

function fileEvent(filename: string, buffer: Buffer, mimeType: string): Record<string, unknown> {
  return { type: "file_download", filename, base64: buffer.toString("base64"), mimeType };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function blankDetails(): AstronaClaimDetails {
  return { memberName: "", memberDob: "", claimNumber: "", datePaid: "", checkNumber: "", portalStatus: "", netAmount: "", cptCodes: [], memoLine1: "", serviceLines: [] };
}

function record(auditRows: Record<string, unknown>[], row: AstronaInputRow | null, step: string, status: string, message: string): void {
  auditRows.push({ timestamp: new Date().toISOString(), input_row_id: row?.inputRowId ?? "", group: row?.group ?? "", payer: row?.payer ?? "", member_id: row?.memberId ?? "", step, status, message });
}

function failure(errorRows: Record<string, unknown>[], row: AstronaInputRow | null, stage: string, reason: string, message: string): void {
  errorRows.push({ timestamp: new Date().toISOString(), input_row_id: row?.inputRowId ?? "", group: row?.group ?? "", payer: row?.payer ?? "", member_id: row?.memberId ?? "", failure_stage: stage, failure_reason: reason, description: message });
}

function logText(auditRows: Record<string, unknown>[], errorRows: Record<string, unknown>[]): string {
  const lines = ["Astrona claim-status run log", "", "Audit"];
  for (const row of auditRows) lines.push(Object.values(row).filter(Boolean).join(" | "));
  lines.push("", "Errors");
  for (const row of errorRows) lines.push(Object.values(row).filter(Boolean).join(" | "));
  return `${lines.join("\n")}\n`;
}

async function processRow(page: Page, row: AstronaInputRow, auditRows: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  record(auditRows, row, "claim_search", "started", "Searching by member ID/member name.");
  await searchAstronaClaims(page, row);
  let count = await getAstronaClaimCount(page);
  const combinedSearchWasEmpty = !count || await astronaShowsNoClaimResults(page);
  if (combinedSearchWasEmpty && row.memberName) {
    const nameCandidates = astronaMemberNameSearchCandidates(row.memberName);
    for (const candidate of nameCandidates) {
      record(auditRows, row, "claim_search", "retry", `No claims found; clearing Member ID and retrying with Member Name "${candidate}".`);
      await searchAstronaClaims(page, row, "member-name", candidate);
      count = await getAstronaClaimCount(page);
      if (count) break;
    }
  }
  record(auditRows, row, "claim_search", "completed", `Found ${count} claim(s).`);
  if (!count) return astronaOutputRows(row, blankDetails(), "no_data", "No claim data found in portal.");

  const matchingClaimNumbers = await getAstronaClaimNumbersForRow(page, row);
  record(auditRows, row, "claim_search", "filtered", `Opening ${matchingClaimNumbers.length} of ${count} claim(s) matching Member Name ${row.memberName} and Date of Service ${row.dos}.`);
  if (!matchingClaimNumbers.length) {
    return astronaOutputRows(row, blankDetails(), "no_data", `No claim result row matched input DOS ${row.dos}.`);
  }

  const output: Record<string, unknown>[] = [];
  let matchedNameAndDos = false;
  let dobMismatch = false;
  for (const claimNumber of matchingClaimNumbers) {
    const opened = await openAstronaClaimByNumber(page, claimNumber);
    try {
      const details = await extractAstronaClaimDetails(page, opened.claimNumber);
      if (!astronaClaimNameMatches(details, row)) continue;
      const serviceLines = astronaServiceLinesForDosAndCpt(details.serviceLines, row.dos, row.cptCode);
      if ((row.dos || row.cptCode) && !serviceLines.length) continue;
      matchedNameAndDos = true;
      if (!astronaClaimDobMatches(details, row)) {
        dobMismatch = true;
        continue;
      }
      if (serviceLines.length || !row.dos) {
        output.push(...astronaOutputRows(row, {
          ...details,
          cptCodes: row.dos ? Array.from(new Set(serviceLines.map((line) => line.cpt).filter(Boolean))) : details.cptCodes,
          serviceLines,
        }));
      }
    } finally {
      await returnToAstronaResults(page, opened.originalUrl);
    }
  }
  if (!output.length && dobMismatch) {
    return astronaOutputRows(row, blankDetails(), "no_data", "Portal claim matched Member Name and DOS, but DOB did not match the input row.");
  }
  if (!output.length && !matchedNameAndDos) {
    return astronaOutputRows(row, blankDetails(), "no_data", "No portal claim matched input Member Name, DOS, and CPT/Procedure Code.");
  }
  if (!output.length && row.dos) {
    return astronaOutputRows(row, blankDetails(), "no_data", `No portal service lines matched input DOS ${row.dos} and CPT ${row.cptCode || "(not provided)"}.`);
  }
  return output;
}

export async function runAstronaClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const outputRows: Record<string, unknown>[] = [];
  const errorRows: Record<string, unknown>[] = [];
  const auditRows: Record<string, unknown>[] = [];
  let total = 0;
  let completed = 0;

  try {
    const input = await parseAstronaInput(formData);
    const rows = readAstronaInputRows(input.inputWorkbookBuffer);
    const credentials = readAstronaCredentials(input.credentialWorkbookBuffer);
    const routing = routeAstronaRows(rows, credentials);
    total = rows.length;
    await context.emit({ type: "progress", completed: 0, total });
    await context.log({ level: "info", message: `Astrona input loaded: ${rows.length} row(s), ${routing.batches.length} Group/Payer login batch(es).` });

    for (const row of rows.filter((candidate) => candidate.validationStatus === "invalid")) {
      failure(errorRows, row, "validation", "invalid_input", row.validationMessage);
      outputRows.push(...astronaOutputRows(row, blankDetails(), "failed", row.validationMessage));
      completed += 1;
      await context.emit({ type: "progress", completed, total });
    }
    for (const row of routing.unmappedRows) {
      const message = `No Astrona credentials matched Group ${row.group} and Payer ${row.payer}.`;
      failure(errorRows, row, "credential_routing", "credentials_not_found", message);
      outputRows.push(...astronaOutputRows(row, blankDetails(), "failed", message));
      completed += 1;
      await context.emit({ type: "progress", completed, total });
    }

    for (const batch of routing.batches) {
      let batchCompleted = 0;
      let browser: Browser | null = null;
      let browserContext: BrowserContext | null = null;
      let page: Page | null = null;
      try {
        const session = await launchAstronaBrowser((message) => context.log({ level: "info", message }));
        browser = session.browser;
        browserContext = session.context;
        page = await browserContext.newPage();
        await loginToAstrona(page, batch.credentials);
        await selectAstronaProviderPortal(page, batch.credentials.payer);
        await goToAstronaClaims(page);
        for (const row of batch.rows) {
          if (context.isCancelled?.()) throw new Error("Astrona processing was cancelled.");
          try {
            outputRows.push(...await processRow(page, row, auditRows));
          } catch (error) {
            const message = errorMessage(error);
            failure(errorRows, row, "claim_processing", "row_failed", message);
            outputRows.push(...astronaOutputRows(row, blankDetails(), "failed", message));
            await context.captureScreenshot?.("astrona-row-error", row.inputRowId);
          }
          completed += 1;
          batchCompleted += 1;
          await context.emit({ type: "progress", completed, total });
        }
      } catch (error) {
        const message = errorMessage(error);
        await context.captureScreenshot?.("astrona-login-navigation-error", batch.rows[batchCompleted]?.inputRowId);
        for (const row of batch.rows.slice(batchCompleted)) {
          failure(errorRows, row, "batch_processing", "login_or_navigation_failed", message);
          outputRows.push(...astronaOutputRows(row, blankDetails(), "failed", message));
          completed += 1;
          await context.emit({ type: "progress", completed, total });
        }
        await context.log({ level: "error", message: `Astrona ${batch.credentials.group}/${batch.credentials.payer} batch failed: ${message}` });
      } finally {
        if (page) {
          await context.log({ level: "info", message: `Signing out Astrona ${batch.credentials.payer} before the next payer login.` });
          await signOutAstrona(page).catch((error) => context.log({ level: "warn", message: `Astrona sign-out cleanup warning: ${errorMessage(error)}` }));
        }
        await closeAutomationResources({ browser, context: browserContext, page, log: (message) => context.log({ level: "info", message }) });
      }
    }
  } catch (error) {
    const message = errorMessage(error);
    failure(errorRows, null, "astrona_run", "fatal_error", message);
    await context.emit({ type: "error", message });
  }

  const workbook = createAstronaWorkbook(outputRows, errorRows, auditRows);
  await context.emit(fileEvent("astrona_output.xlsx", workbook, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
  if (errorRows.length) {
    await context.emit(fileEvent("astrona-run.log", Buffer.from(logText(auditRows, errorRows), "utf8"), "text/plain"));
    await context.emit({ type: "warning", message: `Astrona completed with ${errorRows.length} error(s). Download astrona-run.log for details.` });
  }
  await context.emit({ type: "done" });
}
