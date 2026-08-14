import * as XLSX from "xlsx";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import { getAutomationRuntimeConfig } from "@/backend/src/core/runtime-config";
import type { ScraperContext } from "../../types";
import { launchMedpointBrowser } from "./browser";
import { parseMedpointInput } from "./input";
import { buildOutputRows, detectCurrentIpa, expectedIpaForRow, extractClaimDetail, loginToMedpoint, openClaimDetail, openClaimsSearch, searchClaims } from "./portal";
import type { MedpointAuditRow, MedpointErrorRow, MedpointOutputRow } from "./types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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

function buildWorkbookBuffer(outputRows: MedpointOutputRow[], auditRows: MedpointAuditRow[], errorRows: MedpointErrorRow[]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(outputRows), "Output");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(auditRows), "Audit Log");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(errorRows), "Error Log");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
    generated_at: nowIso(),
    output_rows: outputRows.length,
    error_rows: errorRows.length,
  }]), "Run Summary");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

async function emitScreenshot(context: ScraperContext, page: import("playwright-core").Page, index: number, reason: string) {
  try {
    const bytes = await page.screenshot({ type: "jpeg", quality: 70, fullPage: true });
    await context.emit({
      type: "error_screenshot",
      index,
      filename: `medpoint-${index}-${reason.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.jpg`,
      mimeType: "image/jpeg",
      image: bytes.toString("base64"),
    });
  } catch {
    // Ignore screenshot failures.
  }
}

export async function runMedpointLoginHandoffJob(formData: FormData, context: ScraperContext) {
  const input = await parseMedpointInput(formData);
  const runtimeConfig = getAutomationRuntimeConfig();
  if (runtimeConfig.headless) {
    throw new Error("Medpoint requires a headed local browser because reCAPTCHA must be completed in the live portal window.");
  }

  const auditRows: MedpointAuditRow[] = [];
  const errorRows: MedpointErrorRow[] = [];
  const outputRows: MedpointOutputRow[] = [];
  const log = async (message: string, stage = "general", rowNumber?: number) => {
    auditRows.push({ timestamp: nowIso(), stage, message, row_number: rowNumber });
    await context.log({ level: "info", message, rowIndex: typeof rowNumber === 'number' ? rowNumber : undefined, meta: { stage } });
    await context.emit({ type: "log", message });
  };

  let browser: import("playwright-core").Browser | null = null;
  let browserContext: import("playwright-core").BrowserContext | null = null;
  let page: import("playwright-core").Page | null = null;

  try {
    await context.emit({ type: "progress", completed: 0, total: input.rows.length || 1 });
    const session = await launchMedpointBrowser((message) => log(message, "browser"));
    browser = session.browser;
    browserContext = session.context;
    page = session.context.pages()[0] ?? await session.context.newPage();
    page.setDefaultTimeout(30000);

    await loginToMedpoint({ page, credentials: input.credentials, context, log: (message) => log(message, "login") });
    await openClaimsSearch(page, (message) => log(message, "claims-menu"));

    for (let index = 0; index < input.rows.length; index++) {
      const row = input.rows[index];
      try {
        const currentIpa = await detectCurrentIpa(page);
        const expectedIpa = expectedIpaForRow(row);
        if (expectedIpa && currentIpa && currentIpa.toLowerCase() != expectedIpa.toLowerCase()) {
          await log(`Medpoint current IPA is "${currentIpa}" while row ${row.inputRowNumber} expects "${expectedIpa}". Continuing with the visible IPA.`, "ipa", row.inputRowNumber);
        }
        const searchResultHrefs = await searchClaims(page, row, (message) => log(message, "search", row.inputRowNumber));
        const filtered = row.claimNumber
          ? searchResultHrefs.filter((href) => href.includes(row.claimNumber))
          : searchResultHrefs;
        const resultHrefs = filtered.length > 0 ? filtered : searchResultHrefs;

        if (resultHrefs.length == 0) {
          outputRows.push({
            input_row_number: row.inputRowNumber,
            input_member_last_name: row.memberLastName,
            input_member_first_name: row.memberFirstName,
            input_service_from_date: row.serviceFromDate,
            input_service_to_date: row.serviceToDate,
            input_claim_number: row.claimNumber,
            ipa_context: currentIpa || expectedIpa,
            search_result_index: 0,
            portal_claim_number: "",
            portal_check_number: "",
            portal_date_received: "",
            portal_date_paid: "",
            portal_patient_account: row.patientAccount,
            portal_provider_name: "",
            detail_line_number: "",
            detail_raw_status: "",
            detail_net_amount: "",
            denial_code: "",
            denial_description: "",
            final_status: "No claims found",
            bot_notes: "Medpoint search returned no claim links.",
          });
        } else {
          for (let resultIndex = 0; resultIndex < resultHrefs.length; resultIndex++) {
            const href = resultHrefs[resultIndex];
            await openClaimDetail(page, href);
            const detail = await extractClaimDetail(page);
            outputRows.push(...buildOutputRows(row, currentIpa || expectedIpa, resultIndex + 1, detail));
          }
        }
      } catch (error) {
        const message = errorMessage(error);
        errorRows.push({ input_row_number: row.inputRowNumber, stage: "row", error: message });
        await log(`Medpoint row ${row.inputRowNumber} failed: ${message}`, "row-error", row.inputRowNumber);
        if (page) await emitScreenshot(context, page, row.inputRowNumber, "row-error");
      }
      await context.emit({ type: "progress", completed: index + 1, total: input.rows.length });
    }

    const workbookBuffer = buildWorkbookBuffer(outputRows, auditRows, errorRows);
    await context.emit(downloadableFileEvent("medpoint_output.xlsx", workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    await log(`Medpoint finished with ${outputRows.length} output row(s) and ${errorRows.length} error row(s).`, "complete");
  } catch (error) {
    if (page) await emitScreenshot(context, page, 0, "fatal-error");
    const message = errorMessage(error);
    errorRows.push({ input_row_number: 0, stage: "fatal", error: message });
    await context.emit({ type: "error", message: `Medpoint failed: ${message}` });
    if (outputRows.length > 0 || auditRows.length > 0 || errorRows.length > 0) {
      const workbookBuffer = buildWorkbookBuffer(outputRows, auditRows, errorRows);
      await context.emit(downloadableFileEvent("medpoint_output.xlsx", workbookBuffer, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"));
    }
    throw error;
  } finally {
    await closeAutomationResources({ browser, context: browserContext, page, log: (message) => log(message, "cleanup") });
  }
}
