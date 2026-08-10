import type { Browser, BrowserContext, Page } from "playwright-core";
import { readFile } from "node:fs/promises";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import { saveScreenshotForJob } from "@/backend/src/core/screenshots";
import type { AutomationRunner } from "../../../types";
import type { EligibilityInputRow, EligibilityResult, EligibilityRunInput } from "../../types";
import { findWaystarCredentialsForPayer, readWaystarCredentialProfiles } from "./credentials";
import { readWaystarEligibilityWorkbook } from "./input";
import { getWaystarPayer } from "./payer-registry";
import { loginToWaystar, submitWaystarInquiry } from "./portal";
import { buildWaystarOutputWorkbook } from "./output";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) {
    throw new Error(`${label} is required.`);
  }
  return value;
}

export function createWaystarRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification",
    portalId: "waystar",
    name: "Waystar Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) {
        throw new Error("Waystar eligibility input must be multipart form data.");
      }
      return {
        inputFile: requireFile(input, "inputFile", "Eligibility input file"),
        credentialFile: requireFile(input, "credentialFile", "Credential file"),
      };
    },
    async run(input, context) {
      const routing = await readWaystarEligibilityWorkbook(input.inputFile, input.credentialFile);
      const credentialProfiles = await readWaystarCredentialProfiles(input.credentialFile);
      await context.emit({
        type: "progress",
        completed: 0,
        total: routing.totalRows,
      });
      await context.log({
        level: "info",
        message: `Detected payer column "${routing.payerHeader}" with ${routing.totalRows} rows.`,
        eventName: "eligibility_started",
      });

      for (const batch of routing.batches) {
        await context.log({
          level: "info",
          message: `Routed ${batch.rows.length} row(s) to ${batch.payerName}.`,
          eventName: "eligibility_payer_batch",
          meta: { payerId: batch.payerId, rowCount: batch.rows.length },
        });
      }

      if (routing.unsupportedRows.length > 0) {
        await context.log({
          level: "warn",
          message: `${routing.unsupportedRows.length} row(s) have an empty or unsupported insurance name.`,
          eventName: "eligibility_unsupported_payer",
          meta: { rows: routing.unsupportedRows },
        });
      }

      if (routing.batches.length === 0) {
        throw new Error("No supported Waystar payer rows were found in the workbook.");
      }

      let completed = routing.unsupportedRows.length;
      let failureCount = routing.unsupportedRows.length;
      const inputRows = new Map<number, EligibilityInputRow>(
        routing.batches.flatMap((batch) => batch.rows).map((row) => [row.originalIndex, row]),
      );
      const results = new Map<number, EligibilityResult>();
      const rowsWithMissingData = new Set<number>();
      const rowErrors = new Map<number, string>(
        routing.unsupportedRows.map((row) => [
          row.rowIndex,
          `Unsupported or empty payer "${row.insuranceName || "blank"}".`,
        ]),
      );
      const errorReportLines = routing.unsupportedRows.map((row) =>
        `Row ${row.rowIndex}: unsupported or empty payer "${row.insuranceName || "blank"}".`,
      );
      let browser: Browser | null = null;
      let browserContext: BrowserContext | null = null;
      let page: Page | null = null;
      let activeLoginIdentity: string | null = null;

      try {
        payerBatches: for (const batch of routing.batches) {
          const payer = getWaystarPayer(batch.payerId);
          const credentials = findWaystarCredentialsForPayer(credentialProfiles, payer);
          if (!credentials) {
            failureCount += batch.rows.length;
            completed += batch.rows.length;
            const message = `No matching Waystar credential row was found for ${payer.name}.`;
            const expectedCredential = payer.credentialProject
              ? `Portal=Waystar, Project=${payer.credentialProject}, and Payer=${payer.name}`
              : `Portal=Waystar and Payer=${payer.name}`;
            for (const row of batch.rows) rowErrors.set(row.originalIndex, message);
            await context.log({
              level: "error",
              message: `No matching Waystar credential row was found for ${payer.name}. Add a row with ${expectedCredential}.`,
              eventName: "eligibility_credentials_not_found",
              meta: { payerId: payer.id, rowCount: batch.rows.length },
            });
            errorReportLines.push(`${payer.name}: no matching credential row. Expected ${expectedCredential}.`);
            await context.emit({ type: "progress", completed, total: routing.totalRows });
            continue;
          }

          try {
            const loginIdentity = `${credentials.loginUrl}\u0000${credentials.username}`;
            if (!page || page.isClosed() || !browserContext || activeLoginIdentity !== loginIdentity) {
              await closeAutomationResources({
                browser,
                context: browserContext,
                page,
                log: (message) => context.log({ level: "debug", message, eventName: "eligibility_browser_cleanup" }),
              });
              const session = await launchAutomationBrowser();
              browser = session.browser;
              browserContext = session.context;
              page = await browserContext.newPage();
              await loginToWaystar(page, credentials);
              activeLoginIdentity = loginIdentity;
              await context.log({
                level: "info",
                message: `Waystar login completed for ${payer.name} using its matching credential row.`,
                eventName: "eligibility_waystar_login_complete",
                meta: { payerId: payer.id, credentialPayer: credentials.payer },
              });
            } else {
              await context.log({
                level: "debug",
                message: `Reusing the active Waystar login for ${payer.name}.`,
                eventName: "eligibility_waystar_session_reused",
                meta: { payerId: payer.id, credentialPayer: credentials.payer },
              });
            }

            let batchSuccessCount = 0;
            const timeoutRetryCounts = new Map<number, number>();
            const sessionRetryCounts = new Map<number, number>();
            const fieldRetryCounts = new Map<number, number>();
            for (let rowPosition = 0; rowPosition < batch.rows.length; rowPosition += 1) {
              const row = batch.rows[rowPosition];
              if (context.isCancelled?.()) {
                await context.log({
                  level: "warn",
                  message: "Eligibility run cancellation requested. Creating an Excel file from completed rows.",
                  eventName: "eligibility_cancel_requested",
                });
                break payerBatches;
              }

              try {
                ensureRequiredFields(row, payer.requiredFields);
                let payload = await submitWaystarInquiry({
                  page,
                  credentials,
                  payerName: payer.portalPayerName,
                  serviceTypeCode: payer.serviceTypeCode,
                  patientLookupCode: payer.patientLookupCode,
                  row,
                });
                let result = applyWaystarResultDefaults(payer.parseResult(payload, row), row);
                if (isFailedAtPayerResult(result)) {
                  await context.log({
                    level: "warn",
                    message: `${payer.name} eligibility row ${row.originalIndex} returned Failed at Payer. Waiting and retrying the inquiry once.`,
                    rowIndex: row.originalIndex,
                    eventName: "eligibility_row_retry_failed_at_payer",
                  });
                  await page.waitForTimeout(5000);
                  payload = await submitWaystarInquiry({
                    page,
                    credentials,
                    payerName: payer.portalPayerName,
                    serviceTypeCode: payer.serviceTypeCode,
                    patientLookupCode: payer.patientLookupCode,
                    row,
                  });
                  result = applyWaystarResultDefaults(payer.parseResult(payload, row), row);
                }
                results.set(row.originalIndex, result);
                const extraction = describeEligibilityExtraction(result);
                if (extraction.missing.length > 0) {
                  rowsWithMissingData.add(row.originalIndex);
                  errorReportLines.push(
                    `${payer.name} row ${row.originalIndex}: Waystar's response did not contain values for: ${extraction.missing.join(", ")}. ` +
                    `Data extracted: ${extraction.extracted.join(", ") || "none"}.`,
                  );
                }
                await context.log({
                  level: extraction.missing.length > 0 ? "warn" : "info",
                  message:
                    `${payer.name} eligibility row ${row.originalIndex} completed with ${result.coverageStatus} coverage. ` +
                    `Extracted: ${extraction.extracted.join(", ") || "none"}. ` +
                    `Not fetched: ${extraction.missing.join(", ") || "none"}.`,
                  rowIndex: row.originalIndex,
                  eventName: "eligibility_row_completed",
                  meta: {
                    ...(result.metadata ?? {}),
                    extractedFields: extraction.extracted,
                    missingFields: extraction.missing,
                  },
                });
                batchSuccessCount += 1;
              } catch (error) {
                let message = error instanceof Error ? error.message : "Unknown Waystar eligibility automation error.";
                const sessionRetries = sessionRetryCounts.get(row.originalIndex) ?? 0;
                if (isWaystarSessionLoginError(message) && sessionRetries < 1) {
                  sessionRetryCounts.set(row.originalIndex, sessionRetries + 1);
                  try {
                    await recoverWaystarSession(page, credentials);
                    batch.rows.push(row);
                    await context.log({
                      level: "warn",
                      message: `${payer.name} eligibility row ${row.originalIndex} was redirected to login. Restored the Waystar session and deferred the row for one retry.`,
                      rowIndex: row.originalIndex,
                      eventName: "eligibility_waystar_session_restored",
                    });
                    continue;
                  } catch (recoveryError) {
                    const recoveryMessage = recoveryError instanceof Error
                      ? recoveryError.message
                      : "Unknown Waystar re-login error.";
                    message = `${message} Automatic Waystar re-login failed: ${recoveryMessage}`;
                  }
                }
                const fieldRetries = fieldRetryCounts.get(row.originalIndex) ?? 0;
                if (isWaystarInquiryFieldError(message) && fieldRetries < 1) {
                  fieldRetryCounts.set(row.originalIndex, fieldRetries + 1);
                  await closeWaystarInquiryWindows(page);
                  batch.rows.push(row);
                  await context.log({
                    level: "warn",
                    message: `${payer.name} eligibility row ${row.originalIndex} had a field reset by Waystar. Reopening a clean inquiry window and deferring the row for one retry.`,
                    rowIndex: row.originalIndex,
                    eventName: "eligibility_row_deferred_field_reset",
                  });
                  continue;
                }
                const timeoutRetries = timeoutRetryCounts.get(row.originalIndex) ?? 0;
                if (isWaystarInquiryTimeout(message) && timeoutRetries < 1) {
                  timeoutRetryCounts.set(row.originalIndex, timeoutRetries + 1);
                  await closeWaystarInquiryWindows(page);
                  batch.rows.push(row);
                  await context.log({
                    level: "warn",
                    message: `${payer.name} eligibility row ${row.originalIndex} timed out at the payer. Deferred until the remaining rows finish.`,
                    rowIndex: row.originalIndex,
                    eventName: "eligibility_row_deferred_timeout",
                  });
                  continue;
                }
                failureCount += 1;
                await context.log({
                  level: "error",
                  message: `${payer.name} eligibility row ${row.originalIndex} failed; no eligibility data was extracted. Reason: ${message}`,
                  rowIndex: row.originalIndex,
                  eventName: "eligibility_row_failed",
                });
                errorReportLines.push(
                  `${payer.name} row ${row.originalIndex}: no eligibility data was fetched because the row failed: ${message}`,
                );
                rowErrors.set(row.originalIndex, message);
                const artifact = await saveRowScreenshot(context.jobId, page, row.originalIndex);
                if (artifact) {
                  await context.emit({
                    type: "error_screenshot",
                    index: row.originalIndex,
                    filename: `waystar-eligibility-row-${row.originalIndex}.jpg`,
                    path: artifact.path,
                    image: artifact.image,
                    mimeType: "image/jpeg",
                  });
                }
                if (batchSuccessCount === 0 && isBatchBlockingError(message)) {
                  const unprocessed = batch.rows.length - rowPosition - 1;
                  failureCount += unprocessed;
                  completed += unprocessed;
                  for (const unprocessedRow of batch.rows.slice(rowPosition + 1)) {
                    rowErrors.set(
                      unprocessedRow.originalIndex,
                      "Not attempted because the payer workflow never became ready.",
                    );
                  }
                  errorReportLines.push(`${payer.name}: stopped early; ${unprocessed} remaining row(s) were not attempted because the payer workflow never became ready.`);
                  await context.log({
                    level: "error",
                    message: `Stopping ${payer.name} after the first setup failure because no rows were processed. ${unprocessed} remaining row(s) were not attempted.`,
                    eventName: "eligibility_payer_stopped_no_progress",
                    meta: { payerId: payer.id, unprocessedRows: unprocessed },
                  });
                  completed += 1;
                  await context.emit({ type: "progress", completed, total: routing.totalRows });
                  break;
                }
              }

              completed += 1;
              await context.emit({ type: "progress", completed, total: routing.totalRows });
            }
          } catch (error) {
            failureCount += batch.rows.length;
            completed += batch.rows.length;
            const message = error instanceof Error ? error.message : "Waystar payer login failed.";
            for (const row of batch.rows) {
              if (!results.has(row.originalIndex) && !rowErrors.has(row.originalIndex)) {
                rowErrors.set(row.originalIndex, message);
              }
            }
            errorReportLines.push(`${payer.name}: batch failed before row processing: ${message}`);
            await context.log({
              level: "error",
              message: `${payer.name} batch failed before row processing: ${message}`,
              eventName: "eligibility_payer_batch_failed",
              meta: { payerId: payer.id },
            });
            const artifact = page ? await saveRowScreenshot(context.jobId, page, -1) : null;
            if (artifact) {
              await context.emit({ type: "error_screenshot", index: -1, filename: `waystar-${payer.id}-login-error.jpg`, path: artifact.path, image: artifact.image, mimeType: "image/jpeg" });
            }
            await context.emit({ type: "progress", completed: Math.min(completed, routing.totalRows), total: routing.totalRows });
          }

        }
        const output = await buildWaystarOutputWorkbook({
          inputFile: input.inputFile,
          rows: inputRows,
          results,
          errors: rowErrors,
        });
        await context.emit({
          type: "file_download",
          filename: "waystar-eligibility-output.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          base64: output.toString("base64"),
        });
        await context.log({
          level: "info",
          message: `Created Waystar eligibility output workbook with ${results.size} completed row(s).`,
          eventName: "eligibility_output_created",
        });

        if (failureCount > 0 || rowsWithMissingData.size > 0) {
          const report = [
            "Waystar eligibility error report",
            `Generated: ${new Date().toISOString()}`,
            `Total rows: ${routing.totalRows}`,
            `Failed or unsupported rows: ${failureCount}`,
            `Completed rows with data not fetched: ${rowsWithMissingData.size}`,
            "",
            ...errorReportLines,
          ].join("\n");
          await context.emit({
            type: "file_download",
            filename: "waystar-eligibility-error-report.txt",
            mimeType: "text/plain",
            base64: Buffer.from(report, "utf8").toString("base64"),
          });
          if (failureCount > 0) {
            throw new Error(`Eligibility verification finished with ${failureCount} failed or unsupported row(s). Review the errors and screenshots below.`);
          }
        }
      } finally {
        await closeAutomationResources({
          browser,
          context: browserContext,
          page,
          log: (message) =>
            context.log({
              level: "debug",
              message,
              eventName: "eligibility_browser_cleanup",
            }),
        });
      }
    },
  };
}

const ELIGIBILITY_RESULT_FIELDS: Array<{
  label: string;
  hasValue: (result: EligibilityResult) => boolean;
}> = [
  { label: "Coverage Status", hasValue: (result) => result.coverageStatus !== "unknown" && result.coverageStatus !== "error" },
  { label: "Plan Type", hasValue: (result) => Boolean(result.planType) },
  { label: "Plan Name", hasValue: (result) => Boolean(result.planName) },
  { label: "Plan Status", hasValue: (result) => Boolean(result.planStatus) },
  { label: "Effective Date", hasValue: (result) => Boolean(result.effectiveDate) },
  { label: "Termination Date", hasValue: (result) => Boolean(result.terminationDate) },
  { label: "Premium Paid End Date", hasValue: (result) => Boolean(result.premiumPaidEndDate) },
  { label: "Insurance Type", hasValue: (result) => Boolean(result.insuranceType) },
  { label: "Patient Name", hasValue: (result) => Boolean(result.patientName) },
  { label: "Relationship to Subscriber", hasValue: (result) => Boolean(result.relationshipToSubscriber) },
  { label: "Address", hasValue: (result) => Boolean(result.address) },
  { label: "Member ID", hasValue: (result) => Boolean(result.memberId) },
  { label: "Date of Birth", hasValue: (result) => Boolean(result.dateOfBirth) },
  { label: "Sex", hasValue: (result) => Boolean(result.sex) },
  { label: "Group Number", hasValue: (result) => Boolean(result.groupNumber) },
  { label: "Plan Date", hasValue: (result) => Boolean(result.planDate) },
  { label: "Primary Care Provider", hasValue: (result) => Boolean(result.primaryCareProvider) },
  { label: "IPA", hasValue: (result) => Boolean(result.ipa) },
  { label: "Coverage Description", hasValue: (result) => Boolean(result.coverageDescription) },
  { label: "Coinsurance", hasValue: (result) => Boolean(result.coinsurance) },
  { label: "Copay", hasValue: (result) => Boolean(result.copay) },
  { label: "Deductible", hasValue: (result) => Boolean(result.deductible) },
  { label: "Deductible Met", hasValue: (result) => Boolean(result.deductibleMet) },
  { label: "Out of Pocket", hasValue: (result) => Boolean(result.outOfPocket) },
  { label: "Out of Pocket Met", hasValue: (result) => Boolean(result.outOfPocketMet) },
  { label: "Network", hasValue: (result) => Boolean(result.inOutNetwork) },
  { label: "Benefits", hasValue: (result) => result.benefits.length > 0 },
];

export function describeEligibilityExtraction(result: EligibilityResult): {
  extracted: string[];
  missing: string[];
} {
  if ((result.payerId === "bcbs-ppo" || result.payerId === "cigna-open-access-plus" || result.payerId === "baycare-plus-medicare-advantage" || result.payerId === "aetna" || result.payerId === "aetna-medicare-ppo" || result.payerId === "united-healthcare-all-states" || result.payerId === "aarp-medicare-complete" || result.payerId === "umr" || result.payerId === "humana-medicare-ppo" || result.payerId === "av-med")) {
    const fields = [
      { label: "Coverage Status", value: result.coverageStatus !== "unknown" && result.coverageStatus !== "error", required: true },
      { label: "Eff Date", value: Boolean(result.effectiveDate), required: false },
      { label: "End Date", value: Boolean(result.terminationDate), required: false },
      { label: "Other Ins", value: Boolean(result.otherInsurance), required: false },
      { label: "Other Ins Eff Date", value: Boolean(result.otherInsuranceEffectiveDate), required: false },
      { label: "Relationship to Subscriber", value: Boolean(result.relationshipToSubscriber), required: true },
      { label: "Plan Type", value: Boolean(result.planType), required: true },
      { label: "Bot Insurance Type", value: Boolean(result.insuranceType), required: true },
    ];
    return {
      extracted: fields.filter((field) => field.value).map((field) => field.label),
      missing: fields.filter((field) => field.required && !field.value).map((field) => field.label),
    };
  }

  const extracted: string[] = [];
  const missing: string[] = [];
for (const field of ELIGIBILITY_RESULT_FIELDS) {
    if (field.hasValue(result)) {
      extracted.push(field.label);
      continue;
    }
    if (
      (field.label === "Effective Date" || field.label === "Termination Date") &&
      result.coverageStatus !== "inactive"
    ) {
      continue;
    }
    missing.push(field.label);
  }
  return { extracted, missing };
}

export function applyWaystarResultDefaults(
  result: EligibilityResult,
  row: EligibilityInputRow,
): EligibilityResult {
  return {
    ...result,
    relationshipToSubscriber:
      result.relationshipToSubscriber || row.relationshipToSubscriber || "Self",
  };
}
function isFailedAtPayerResult(result: EligibilityResult): boolean {
  return String(result.planStatus || "").toLowerCase().includes("failed at payer");
}
function isWaystarInquiryFieldError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("did not fill correctly") ||
    normalized.includes("inquiry field") && normalized.includes("was not visible") ||
    normalized.includes("inquiry fields were not present on the page before submit");
}
function isWaystarSessionLoginError(message: string): boolean {
  return message.toLowerCase().includes("waystar session returned to the login page");
}

async function closeWaystarInquiryWindows(page: Page): Promise<void> {
  const secondaryPages = page.context().pages().filter((candidate) => candidate !== page && !candidate.isClosed());
  await Promise.all(secondaryPages.map((candidate) => candidate.close().catch(() => {})));
}
async function recoverWaystarSession(page: Page, credentials: Parameters<typeof loginToWaystar>[1]): Promise<void> {
  if (page.isClosed()) {
    throw new Error("The main Waystar page was closed.");
  }

  await closeWaystarInquiryWindows(page);
  await loginToWaystar(page, credentials);
}
function isWaystarInquiryTimeout(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("eligibility inquiry timed out at the payer") ||
    normalized.includes("eligibility inquiry timed out while waiting for the payer response");
}function isBatchBlockingError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "payer selection did not activate",
    "provider field did not become active",
    "waiting for locator('#ddlprov",
    "payer control was not found",
    "inquiry controls",
  ].some((fragment) => normalized.includes(fragment));
}

function ensureRequiredFields(row: EligibilityInputRow, requiredFields: string[]): void {
  const missingFields = requiredFields.filter((field) => {
    switch (field) {
      case "memberId":
        return !row.memberId && !row.subscriberId;
      case "patientFirstName":
        return !row.patientFirstName;
      case "patientLastName":
        return !row.patientLastName;
      case "dateOfBirth":
        return !row.dateOfBirth;
      default:
        return !String((row.raw as Record<string, unknown>)[field] ?? "").trim();
    }
  });

  if (missingFields.length > 0) {
    throw new Error(`Missing required eligibility fields: ${missingFields.join(", ")}.`);
  }
}

async function saveRowScreenshot(jobId: string, page: Page, rowIndex: number): Promise<{ path: string; image: string } | null> {
  try {
    const path = await saveScreenshotForJob({
      jobId,
      page,
      filename: `waystar-eligibility-row-${rowIndex}.jpg`,
    });
    const image = (await readFile(path)).toString("base64");
    return { path, image };
  } catch {
    return null;
  }
}


