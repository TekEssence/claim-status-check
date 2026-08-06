import type { Browser, BrowserContext, Page } from "playwright-core";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { ScraperContext } from "../../types";
import { launchAstronaBrowser } from "./browser";
import { parseAstronaInput, readAstronaCredentials, readAstronaInputRows, routeAstronaRows } from "./input";
import { astronaClaimDobMatches, astronaClaimNameMatches, astronaMemberNameSearchCandidates, astronaServiceLinesForDosAndCpt, astronaShowsNoClaimResults, extractAstronaClaimDetails, getAstronaClaimCount, getAstronaClaimNumbersForRow, goToAstronaClaims, goToNextAstronaClaimsPage, loginToAstrona, openAstronaClaimByNumber, returnToAstronaResults, searchAstronaClaims, selectAstronaProviderPortal, signOutAstrona } from "./portal";
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

async function processRow(page: Page, row: AstronaInputRow, auditRows: Record<string, unknown>[], context: ScraperContext): Promise<Record<string, unknown>[]> {
  const member = row.memberId || row.memberName || `input row ${row.inputRowId}`;
  const liveLog = (level: "info" | "warn", message: string) => context.log({ level, message: `[Astrona row ${row.inputRowId}] ${message}`, rowIndex: row.inputRowId });
  record(auditRows, row, "claim_search", "started", "Searching by member ID/member name.");
  await liveLog("info", `Searching member ${member}, DOS ${row.dos || "not provided"}${row.cptCode ? `, CPT ${row.cptCode}` : ""}.`);
  await searchAstronaClaims(page, row);
  let count = await getAstronaClaimCount(page);
  const combinedSearchWasEmpty = !count || await astronaShowsNoClaimResults(page);
  if (combinedSearchWasEmpty && row.memberName) {
    const nameCandidates = astronaMemberNameSearchCandidates(row.memberName);
    for (const candidate of nameCandidates) {
      record(auditRows, row, "claim_search", "retry", `No claims found; clearing Member ID and retrying with Member Name "${candidate}".`);
      await liveLog("info", `No results from Member ID/name search. Retrying with member name "${candidate}".`);
      await searchAstronaClaims(page, row, "member-name", candidate);
      count = await getAstronaClaimCount(page);
      if (count) break;
    }
  }
  record(auditRows, row, "claim_search", "completed", `Found ${count} claim(s).`);
  await liveLog(count ? "info" : "warn", count ? `Portal returned ${count} claim(s); checking DOS and service lines.` : "No claims were returned by the portal search.");
  if (!count) return astronaOutputRows(row, blankDetails(), "no_data", "No claim data found in portal.");

  const output: Record<string, unknown>[] = [];
  let matchedNameAndDos = false;
  let dobMismatch = false;
  const availablePortalDos = new Set<string>();
  const processedClaims = new Set<string>();
  let resultsPage = 1;
  let discoveredClaimLinks = false;
  while (true) {
    const pageClaimNumbers = await getAstronaClaimNumbersForRow(page, row);
    if (pageClaimNumbers.length) discoveredClaimLinks = true;
    record(auditRows, row, "claim_search", "filtered", `Results page ${resultsPage}: opening ${pageClaimNumbers.length} discovered claim(s); DOS will be verified from claim detail service lines.`);
    await liveLog("info", `Checking Astrona results page ${resultsPage} (${pageClaimNumbers.length} claim(s)).`);

    for (const claimNumber of pageClaimNumbers) {
      if (processedClaims.has(claimNumber)) continue;
      processedClaims.add(claimNumber);
      await liveLog("info", `Opening claim ${claimNumber} and reading all service lines.`);
      const opened = await openAstronaClaimByNumber(page, claimNumber);
      try {
        const details = await extractAstronaClaimDetails(page, opened.claimNumber);
        if (!astronaClaimNameMatches(details, row)) continue;
        for (const line of details.serviceLines) {
          if (line.from) availablePortalDos.add(line.from);
          if (line.to) availablePortalDos.add(line.to);
        }
        const serviceLines = astronaServiceLinesForDosAndCpt(details.serviceLines, row.dos, row.cptCode);
        await liveLog("info", `Claim ${claimNumber}: extracted ${details.serviceLines.length} service line(s); ${serviceLines.length} matched the requested DOS/CPT.`);
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

    if (resultsPage >= 5) {
      await liveLog("info", "Reached the maximum of 5 Astrona result pages for this member.");
      break;
    }
    if (!await goToNextAstronaClaimsPage(page)) break;
    resultsPage += 1;
    await liveLog("info", `Requested DOS was not confirmed on the previous results page; moving to page ${resultsPage}.`);
  }
  if (!discoveredClaimLinks) {
    await liveLog("warn", "The portal reported claims, but no claim-number links could be discovered while checking all result pages.");
    return astronaOutputRows(row, blankDetails(), "no_data", "Portal reported claim results, but no claim-number links could be extracted from the results grid.");
  }
  if (!output.length && dobMismatch) {
    await liveLog("warn", "Member name and DOS matched, but portal DOB did not match the input DOB.");
    return astronaOutputRows(row, blankDetails(), "no_data", "Portal claim matched Member Name and DOS, but DOB did not match the input row.");
  }
  if (!output.length && !matchedNameAndDos) {
    const available = availablePortalDos.size ? ` Playwright saw portal DOS: ${[...availablePortalDos].join(", ")}.` : " Playwright did not extract any service-line DOS values from the opened claims.";
    const message = `No data found after checking ${resultsPage} Astrona result page(s) for the input Member Name, DOS, and CPT/Procedure Code.${available}`;
    await liveLog("warn", message);
    return astronaOutputRows(row, blankDetails(), "no_data", message);
  }
  if (!output.length && row.dos) {
    await liveLog("warn", `No service line matched DOS ${row.dos} and CPT ${row.cptCode || "not provided"}.`);
    return astronaOutputRows(row, blankDetails(), "no_data", `No portal service lines matched input DOS ${row.dos} and CPT ${row.cptCode || "(not provided)"}.`);
  }
  await liveLog("info", `Member data fetched successfully. Writing ${output.length} matched output row(s).`);
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
    await context.emit({ type: "progress", completed: 0, total, currentRow: rows[0]?.inputRowId });
    await context.log({ level: "info", message: `Astrona input loaded: ${rows.length} row(s), ${routing.batches.length} Group/Payer login batch(es).` });

    for (const row of rows.filter((candidate) => candidate.validationStatus === "invalid")) {
      failure(errorRows, row, "validation", "invalid_input", row.validationMessage);
      outputRows.push(...astronaOutputRows(row, blankDetails(), "failed", row.validationMessage));
      completed += 1;
      await context.emit({ type: "progress", completed, total, currentRow: row.inputRowId });
    }
    for (const row of routing.unmappedRows) {
      const message = `No Astrona credentials matched Group ${row.group} and Payer ${row.payer}.`;
      failure(errorRows, row, "credential_routing", "credentials_not_found", message);
      outputRows.push(...astronaOutputRows(row, blankDetails(), "failed", message));
      completed += 1;
      await context.emit({ type: "progress", completed, total, currentRow: row.inputRowId });
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
        await context.log({ level: "info", message: `Opening Astrona login for ${batch.credentials.group}/${batch.credentials.payer}.` });
        await loginToAstrona(page, batch.credentials);
        await context.log({ level: "info", message: `Astrona login successful for ${batch.credentials.group}/${batch.credentials.payer}. Selecting provider portal.` });
        await selectAstronaProviderPortal(page, batch.credentials.payer);
        await context.log({ level: "info", message: `Provider portal ${batch.credentials.payer} selected. Opening Claims page.` });
        await goToAstronaClaims(page);
        await context.log({ level: "info", message: `Astrona Claims page loaded. Starting ${batch.rows.length} member row(s).` });
        for (const row of batch.rows) {
          if (context.isCancelled?.()) throw new Error("Astrona processing was cancelled.");
          try {
            const rowOutput = await processRow(page, row, auditRows, context);
            outputRows.push(...rowOutput);
            await context.emit({ type: "astrona_result", rows: rowOutput });
          } catch (error) {
            const message = errorMessage(error);
            await context.log({ level: "error", message: `[Astrona row ${row.inputRowId}] Member ${row.memberId || row.memberName}: processing failed — ${message}`, rowIndex: row.inputRowId });
            failure(errorRows, row, "claim_processing", "row_failed", message);
            outputRows.push(...astronaOutputRows(row, blankDetails(), "failed", message));
            await context.captureScreenshot?.("astrona-row-error", row.inputRowId);
          }
          completed += 1;
          batchCompleted += 1;
          await context.emit({ type: "progress", completed, total, currentRow: row.inputRowId });
        }
      } catch (error) {
        const message = errorMessage(error);
        await context.captureScreenshot?.("astrona-login-navigation-error", batch.rows[batchCompleted]?.inputRowId);
        for (const row of batch.rows.slice(batchCompleted)) {
          failure(errorRows, row, "batch_processing", "login_or_navigation_failed", message);
          outputRows.push(...astronaOutputRows(row, blankDetails(), "failed", message));
          completed += 1;
          await context.emit({ type: "progress", completed, total, currentRow: row.inputRowId });
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
