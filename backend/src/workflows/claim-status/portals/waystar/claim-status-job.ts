import fs from "node:fs/promises";
import path from "node:path";
import { getJobDataPath } from "@/backend/src/core/storage";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import { saveScreenshotForJob } from "@/backend/src/core/screenshots";
import type { Page } from "playwright-core";
import type { ScraperContext } from "../../types";
import { launchWaystarBrowser } from "./browser";
import { parseWaystarInput } from "./input";
import { createWaystarOutputWorkbookBuffer } from "./output-writer";
import {
  extractWaystarEobText,
  findMatchingClaimRow,
  loginToWaystarClaimStatus,
  navigateToWaystarClaimSearch,
  openWaystarEobPopup,
  openWaystarHistoryPopup,
  parseWaystarEobText,
  searchWaystarClaim,
  summarizeWaystarHistoryText,
} from "./portal";
import type { WaystarAuditRow, WaystarClaimExtraction, WaystarClaimInputRow, WaystarErrorRow, WaystarOutputRow } from "./types";

function nowIso(): string {
  return new Date().toISOString();
}

function downloadableFileEvent(filename: string, buffer: Buffer, mimeType: string): Record<string, unknown> {
  return {
    type: "file_download",
    filename,
    base64: buffer.toString("base64"),
    mimeType,
  };
}

function createOutputFilename(): string {
  return `waystar_claimstatus_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}.xlsx`;
}

function formatWaystarDisplayDate(value: string): string {
  const text = value.trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) {
    return `${iso[2]}/${iso[3]}/${iso[1]}`;
  }
  return text;
}

function formatWaystarShortDate(value: string): string {
  const display = formatWaystarDisplayDate(value);
  const parts = display.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!parts) return display;
  return `${parts[1]}/${parts[2]}/${parts[3].slice(-2)}`;
}

function buildWaystarFinalStatus(
  row: WaystarClaimInputRow,
  extraction: WaystarClaimExtraction,
  line: WaystarClaimExtraction["procedureLines"][number],
): string {
  const dos = formatWaystarDisplayDate(line.serviceDate || row.dos);
  const checkDate = formatWaystarShortDate(extraction.checkDate || "");
  const account = extraction.account || "";

  if (line.denialCodes.length > 0) {
    const denialReason = line.denialReasons.find((reason) => reason.trim()) || "";
    return `DOS ${dos}: Checked waystar portal denied on ${checkDate} denial reason ${denialReason}. Acnt# ${account}.`.trim();
  }

  const provPd = line.provPd || "0.00";
  const deduct = line.deduct || "0.00";
  const coins = line.coins || "0.00";
  const eft = extraction.eft || "";
  const checkAmount = extraction.checkAmount || "";
  return `DOS ${dos}: Checked waystar portal paid on ${checkDate} PROV PD $${provPd} with COINS/deduct of $${coins}/$${deduct} EFT/Check # ${eft}. ACNT # ${account}. Check Amount: $${checkAmount}`.trim();
}

function normalizeWaystarOutputValue(value: string, fallback = "NA"): string {
  const text = value.trim();
  return text ? text : fallback;
}

function splitDenialSlots(line: WaystarClaimExtraction["procedureLines"][number]): {
  denialCode1: string;
  denialReason1: string;
  denialCode2: string;
  denialReason2: string;
  denialCode3: string;
  denialReason3: string;
} {
  const codes = line.denialCodes.slice(0, 3);
  const reasons = line.denialReasons.slice(0, 3);
  return {
    denialCode1: codes[0] || "",
    denialReason1: reasons[0] || "",
    denialCode2: codes[1] || "",
    denialReason2: reasons[1] || "",
    denialCode3: codes[2] || "",
    denialReason3: reasons[2] || "",
  };
}

function buildWaystarMissingEobOutputRow(row: WaystarClaimInputRow): WaystarOutputRow {
  return {
    sno: `${row.inputRowId}.`,
    name: row.patientName,
    group: normalizeWaystarOutputValue(row.group),
    servDate: normalizeWaystarOutputValue(row.dos),
    icn: "NA",
    acnt: "NA",
    eft: "NA",
    productionDate: "NA",
    checkDate: "NA",
    proc: "NA",
    checkAmt: "NA",
    billed: "NA",
    allowed: "NA",
    deduct: "NA",
    coins: "NA",
    provPd: "NA",
    denialCode1: "NA",
    denialReason1: "NA",
    denialCode2: "NA",
    denialReason2: "NA",
    denialCode3: "NA",
    denialReason3: "NA",
    status: "NA",
    finalStatus: "NA",
    remarks: "eob was not in the waystar portal ",
  };
}

function buildOutputRows(row: WaystarClaimInputRow, extraction: WaystarClaimExtraction): WaystarOutputRow[] {
  const procedureLines = extraction.procedureLines.length > 0
    ? extraction.procedureLines
    : [{ serviceDate: row.dos, proc: "", billed: "", allowed: "", deduct: "", coins: "", provPd: "", subTotals: "", denialCodes: [], denialReasons: [] }];

  return procedureLines.map((line, index) => {
    const denialSlots = splitDenialSlots(line);
    return {
      sno: index === 0 ? `${row.inputRowId}.` : "",
      name: normalizeWaystarOutputValue(row.patientName),
      group: normalizeWaystarOutputValue(row.group),
      servDate: normalizeWaystarOutputValue(line.serviceDate || row.dos),
      icn: normalizeWaystarOutputValue(extraction.icn),
      acnt: normalizeWaystarOutputValue(extraction.account),
      eft: normalizeWaystarOutputValue(extraction.eft),
      productionDate: normalizeWaystarOutputValue(extraction.productionDate),
      checkDate: normalizeWaystarOutputValue(extraction.checkDate),
      proc: normalizeWaystarOutputValue(line.proc),
      checkAmt: normalizeWaystarOutputValue(extraction.checkAmount),
      billed: normalizeWaystarOutputValue(line.billed),
      allowed: normalizeWaystarOutputValue(line.allowed),
      deduct: normalizeWaystarOutputValue(line.deduct),
      coins: normalizeWaystarOutputValue(line.coins),
      provPd: normalizeWaystarOutputValue(line.provPd),
      denialCode1: normalizeWaystarOutputValue(denialSlots.denialCode1),
      denialReason1: normalizeWaystarOutputValue(denialSlots.denialReason1),
      denialCode2: normalizeWaystarOutputValue(denialSlots.denialCode2),
      denialReason2: normalizeWaystarOutputValue(denialSlots.denialReason2),
      denialCode3: normalizeWaystarOutputValue(denialSlots.denialCode3),
      denialReason3: normalizeWaystarOutputValue(denialSlots.denialReason3),
      status: normalizeWaystarOutputValue(line.denialCodes.length > 0 ? "denial" : "paid"),
      finalStatus: normalizeWaystarOutputValue(buildWaystarFinalStatus(row, extraction, line)),
      remarks: normalizeWaystarOutputValue(extraction.remarks || ""),
    };
  });
}

function addAudit(auditRows: WaystarAuditRow[], inputRowId: number, step: string, status: string, message: string) {
  auditRows.push({
    timestamp: nowIso(),
    inputRowId,
    step,
    status,
    message,
  });
}

function addError(errorRows: WaystarErrorRow[], row: WaystarClaimInputRow, errorType: string, errorMessage: string) {
  errorRows.push({
    timestamp: nowIso(),
    inputRowId: row.inputRowId,
    patientName: row.patientName,
    responsiblePayer: row.responsiblePayer,
    dos: row.dos,
    errorType,
    errorMessage,
  });
}

async function captureWaystarDiagnostics(context: ScraperContext, page: Page, row: WaystarClaimInputRow, reason: string) {
  const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-");

  try {
    const filename = `waystar-row-${row.inputRowId}-${safeReason}.jpg`;
    const screenshotPath = await saveScreenshotForJob({ jobId: context.jobId, page, filename, quality: 70 });
    const bytes = await fs.readFile(screenshotPath);
    await context.emit({
      type: "error_screenshot",
      index: row.inputRowId,
      filename,
      path: screenshotPath,
      mimeType: "image/jpeg",
      image: bytes.toString("base64"),
    });
  } catch {
    // Ignore screenshot capture failures.
  }

  try {
    const html = await page.content();
    if (!html) return;

    const artifactDir = getJobDataPath(context.jobId, "screenshots");
    await fs.mkdir(artifactDir, { recursive: true }).catch(() => {});
    const htmlPath = path.join(artifactDir, `waystar-row-${row.inputRowId}-${safeReason}.html`);
    await fs.writeFile(htmlPath, html, "utf8");
    await context.emit({
      type: "debug_html",
      index: row.inputRowId,
      filename: path.basename(htmlPath),
      path: htmlPath,
      html,
    });
  } catch {
    // Ignore HTML capture failures.
  }
}

function escapeWaystarDebugHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function summarizeWaystarExtractionGaps(extraction: WaystarClaimExtraction): string[] {
  const issues: string[] = [];
  if (!extraction.checkDate.trim()) {
    issues.push("Missing check date.");
  }

  extraction.procedureLines.forEach((line, index) => {
    const label = `PROC row ${index + 1}`;
    if (!line.proc.trim()) {
      issues.push(`${label}: missing PROC.`);
    }
    if (!line.billed.trim()) {
      issues.push(`${label}: missing BILLED.`);
    }
    if (!line.allowed.trim()) {
      issues.push(`${label}: missing ALLOWED.`);
    }
    if (!line.deduct.trim()) {
      issues.push(`${label}: missing DEDUCT.`);
    }
    if (!line.coins.trim()) {
      issues.push(`${label}: missing COINS.`);
    }
    if (!line.provPd.trim()) {
      issues.push(`${label}: missing PROV PD.`);
    }

    line.denialCodes.forEach((code, denialIndex) => {
      if (!(line.denialReasons[denialIndex] || "").trim()) {
        issues.push(`${label}: missing denial reason for ${code}.`);
      }
    });
  });

  return issues;
}

async function captureWaystarEobTextDiagnostics(
  context: ScraperContext,
  row: WaystarClaimInputRow,
  reason: string,
  eobText: string,
  extraction: WaystarClaimExtraction,
  issues: string[],
) {
  try {
    const safeReason = reason.replace(/[^a-z0-9_-]+/gi, "-");
    const artifactDir = getJobDataPath(context.jobId, "screenshots");
    await fs.mkdir(artifactDir, { recursive: true }).catch(() => {});
    const htmlPath = path.join(artifactDir, `waystar-row-${row.inputRowId}-${safeReason}-eob-text.html`);
    const html = [
      '<html><body style="font-family:Consolas,monospace;white-space:pre-wrap">',
      `<h2>Waystar Row ${row.inputRowId} EOB Debug</h2>`,
      `<p><strong>Patient:</strong> ${escapeWaystarDebugHtml(row.patientName)}</p>`,
      `<p><strong>DOS:</strong> ${escapeWaystarDebugHtml(row.dos)}</p>`,
      `<p><strong>Issues:</strong> ${escapeWaystarDebugHtml(issues.join(" | "))}</p>`,
      "<h3>Parsed Extraction</h3>",
      `<pre>${escapeWaystarDebugHtml(JSON.stringify(extraction, null, 2))}</pre>`,
      "<h3>Raw EOB Text</h3>",
      `<pre>${escapeWaystarDebugHtml(eobText)}</pre>`,
      "</body></html>",
    ].join("\n");
    await fs.writeFile(htmlPath, html, "utf8");
    await context.emit({
      type: "debug_html",
      index: row.inputRowId,
      filename: path.basename(htmlPath),
      path: htmlPath,
      html,
    });
  } catch {
    // Ignore raw EOB diagnostic capture failures.
  }
}

async function closePageQuietly(page: Page | null) {
  if (!page) return;
  await page.close().catch(() => {});
}

const HISTORY_POPUP_RETRY_ATTEMPTS = 3;
const EOB_POPUP_RETRY_ATTEMPTS = 3;

function getFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasMeaningfulWaystarExtraction(extraction: WaystarClaimExtraction): boolean {
  if (!extraction.checkDate.trim()) {
    return false;
  }

  return extraction.procedureLines.some((line) =>
    Boolean(line.proc.trim() || line.billed.trim() || line.allowed.trim() || line.subTotals.trim()),
  );
}

async function markRowFailed(options: {
  context: ScraperContext;
  page: Page;
  row: WaystarClaimInputRow;
  errorRows: WaystarErrorRow[];
  auditRows: WaystarAuditRow[];
  errorType: string;
  step: string;
  message: string;
  captureScreenshot?: boolean;
}) {
  const { context, page, row, errorRows, auditRows, errorType, step, message, captureScreenshot } = options;
  addError(errorRows, row, errorType, message);
  addAudit(auditRows, row.inputRowId, step, "failed", message);
  if (captureScreenshot) {
    await captureWaystarDiagnostics(context, page, row, step);
  }
  await context.log({ level: "error", message: `Waystar row ${row.inputRowId} failed: ${message}`, rowIndex: row.inputRowId });
}

export async function runWaystarClaimStatusJob(formData: FormData, context: ScraperContext): Promise<void> {
  const input = await parseWaystarInput(formData);
  const outputRows: WaystarOutputRow[] = [];
  const errorRows: WaystarErrorRow[] = [];
  const auditRows: WaystarAuditRow[] = [];
  let completed = 0;
  let browser: Awaited<ReturnType<typeof launchWaystarBrowser>>["browser"] | null = null;
  let browserContext: Awaited<ReturnType<typeof launchWaystarBrowser>>["context"] | null = null;
  let page: Page | null = null;

  await context.log({ level: "info", message: `Waystar input loaded: ${input.totalRows} total row(s), ${input.claimRows.length} valid row(s), ${input.invalidRows.length} invalid row(s).` });
  await context.emit({ type: "progress", completed: 0, total: input.totalRows });

  for (const invalidRow of input.invalidRows) {
    errorRows.push({
      timestamp: nowIso(),
      inputRowId: invalidRow.inputRowId,
      patientName: invalidRow.patientName,
      responsiblePayer: invalidRow.responsiblePayer,
      dos: invalidRow.dos,
      errorType: "input_validation",
      errorMessage: invalidRow.error,
    });
    addAudit(auditRows, invalidRow.inputRowId, "input_validation", "skipped", invalidRow.error);
    await context.log({ level: "warn", message: `Waystar row ${invalidRow.inputRowId} skipped: ${invalidRow.error}` });
    completed += 1;
    await context.emit({ type: "progress", completed, total: input.totalRows });
  }

  try {
    if (input.claimRows.length > 0) {
      const session = await launchWaystarBrowser();
      browser = session.browser;
      browserContext = session.context;
      page = await browserContext.newPage();
      await loginToWaystarClaimStatus(page, input.credentials);
      await context.log({ level: "info", message: "Waystar login completed successfully." });
      await navigateToWaystarClaimSearch(page);
      await context.log({ level: "info", message: "Waystar Claim Search page is ready." });
    }

    for (const row of input.claimRows) {
      if (context.isCancelled?.()) {
        await context.emit({ type: "cancelled", message: "Waystar processing cancelled." });
        break;
      }
      if (!page) break;

      await context.log({
        level: "info",
        message: `Waystar row ${row.inputRowId}: searching ${row.patientName} | ${row.responsiblePayer} | ${row.dos}.`,
        rowIndex: row.inputRowId,
      });
      addAudit(auditRows, row.inputRowId, "claim_search", "started", "Submitting Waystar claim search.");

      let historyPopup: Page | null = null;

      try {
        await searchWaystarClaim(page, row);
        addAudit(auditRows, row.inputRowId, "claim_search", "completed", "Search results finished loading for the current patient.");

        const matchedRow = await findMatchingClaimRow(page, row);
        if (!matchedRow) {
          const message = "No matching claim was found in Waystar Claim Search results.";
          addAudit(auditRows, row.inputRowId, "claim_match", "not_found", message);
          await markRowFailed({
            context,
            page,
            row,
            errorRows,
            auditRows,
            errorType: "claim_not_found",
            step: "claim_match",
            message,
          });
          continue;
        }

        addAudit(auditRows, row.inputRowId, "claim_match", "selected", "Selected the best matching claim row and latest transaction date for processing.");

        let historyFailureReason = "";
        for (let attempt = 1; attempt <= HISTORY_POPUP_RETRY_ATTEMPTS; attempt += 1) {
          historyFailureReason = "";
          addAudit(auditRows, row.inputRowId, "history", "attempt", `Attempt ${attempt} to open History.`);
          historyPopup = await openWaystarHistoryPopup(page, matchedRow).catch((error) => {
            historyFailureReason = `History popup attempt ${attempt} failed: ${getFailureMessage(error)}`;
            return null;
          });
          if (historyPopup) {
            break;
          }
          if (!historyFailureReason) {
            historyFailureReason = `History popup did not open on attempt ${attempt}.`;
          }
          addAudit(auditRows, row.inputRowId, "history", "retry", historyFailureReason);
        }

        if (!historyPopup) {
          const historyFailureMessage = historyFailureReason || "History popup did not open after all retry attempts.";
          await markRowFailed({
            context,
            page,
            row,
            errorRows,
            auditRows,
            errorType: "history_not_available",
            step: "history",
            message: historyFailureMessage,
            captureScreenshot: true,
          });
          addAudit(auditRows, row.inputRowId, "history", "abort", "Fail-fast triggered after History did not open. Stopping the Waystar run on this patient.");
          throw new Error(`WAYSTAR_HISTORY_FAIL_FAST: ${historyFailureMessage}`);
        }

        let extraction: WaystarClaimExtraction | null = null;
        let historySummary = "";

        try {
          await historyPopup.bringToFront().catch(() => {});
          const historyText = await historyPopup.locator("body").innerText().catch(() => "");
          historySummary = summarizeWaystarHistoryText(historyText);
          addAudit(auditRows, row.inputRowId, "history", "opened", "Opened History for the selected latest transaction row.");

          let eobFailureReason = "";
          for (let attempt = 1; attempt <= EOB_POPUP_RETRY_ATTEMPTS; attempt += 1) {
            eobFailureReason = "";
            addAudit(auditRows, row.inputRowId, "eob", "attempt", `Attempt ${attempt} to open EOB from History.`);
            let eobPopup: Page | null = null;

            try {
              eobPopup = await openWaystarEobPopup(historyPopup).catch((error) => {
                eobFailureReason = `EOB popup attempt ${attempt} failed: ${getFailureMessage(error)}`;
                return null;
              });

              if (!eobPopup) {
                if (!eobFailureReason) {
                  eobFailureReason = `EOB popup did not open on attempt ${attempt}.`;
                }
                addAudit(auditRows, row.inputRowId, "eob", "retry", eobFailureReason);
                continue;
              }

              await eobPopup.bringToFront().catch(() => {});
              const eobText = await extractWaystarEobText(eobPopup);
              const candidateExtraction = parseWaystarEobText(eobText);
              candidateExtraction.historySummary = historySummary;
              const extractionIssues = summarizeWaystarExtractionGaps(candidateExtraction);

              if (extractionIssues.length > 0) {
                await captureWaystarEobTextDiagnostics(
                  context,
                  row,
                  `attempt-${attempt}`,
                  eobText,
                  candidateExtraction,
                  extractionIssues,
                );
                addAudit(auditRows, row.inputRowId, "eob_debug", "captured", extractionIssues.join(" | "));
              }

              if (!hasMeaningfulWaystarExtraction(candidateExtraction)) {
                eobFailureReason = `EOB extraction returned incomplete claim data on attempt ${attempt}.`;
                addAudit(auditRows, row.inputRowId, "eob", "retry", eobFailureReason);
                continue;
              }

              extraction = candidateExtraction;
              addAudit(auditRows, row.inputRowId, "eob", "opened", "Opened EOB from the History page and extracted claim data.");
              break;
            } finally {
              if (eobPopup && eobPopup !== historyPopup) {
                await closePageQuietly(eobPopup);
              }
              await historyPopup.bringToFront().catch(() => {});
            }
          }

          if (!extraction) {
            await markRowFailed({
              context,
              page,
              row,
              errorRows,
              auditRows,
              errorType: "eob_not_available",
              step: "eob",
              message: eobFailureReason || "EOB did not open or extract successfully after all retry attempts.",
              captureScreenshot: true,
            });
            outputRows.push(buildWaystarMissingEobOutputRow(row));
            continue;
          }
        } finally {
          if (historyPopup !== page) {
            await closePageQuietly(historyPopup);
            await page.bringToFront().catch(() => {});
          }
        }

        outputRows.push(...buildOutputRows(row, extraction));
        addAudit(auditRows, row.inputRowId, "output", "completed", `Wrote ${extraction.procedureLines.length || 1} extracted EOB row(s) to the output workbook.`);
        await context.log({ level: "info", message: `Waystar row ${row.inputRowId} completed with extracted EOB data.`, rowIndex: row.inputRowId });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("WAYSTAR_HISTORY_FAIL_FAST:")) {
          throw error;
        }
        await markRowFailed({
          context,
          page,
          row,
          errorRows,
          auditRows,
          errorType: "row_processing",
          step: "row_processing",
          message,
          captureScreenshot: true,
        });
      } finally {
        completed += 1;
        await context.emit({ type: "progress", completed, total: input.totalRows });
        if (page) {
          await navigateToWaystarClaimSearch(page).catch(() => {});
        }
      }
    }

    const workbookBuffer = await createWaystarOutputWorkbookBuffer({
      outputRows,
      errorRows,
      auditRows,
    });
    await context.emit(downloadableFileEvent(createOutputFilename(), workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));

    if (errorRows.length > 0) {
      await context.emit({ type: "warning", message: `Waystar completed with ${errorRows.length} error row(s).` });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Waystar automation error.";
    try {
      const workbookBuffer = await createWaystarOutputWorkbookBuffer({
        outputRows,
        errorRows,
        auditRows,
      });
      await context.emit(downloadableFileEvent(`waystar_partial_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}.xlsx`, workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    } catch {
      // Ignore partial workbook emission failures.
    }
    await context.emit({ type: "error", message });
  } finally {
    await closeAutomationResources({ browser, context: browserContext, page, log: async () => {} });
    await context.emit({ type: "done" });
  }
}
