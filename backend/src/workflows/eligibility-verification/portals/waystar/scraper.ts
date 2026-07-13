import type { Browser, BrowserContext, Page } from "playwright-core";
import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import { saveScreenshotForJob } from "@/backend/src/core/screenshots";
import type { AutomationRunner } from "../../../types";
import type { EligibilityInputRow, EligibilityRunInput } from "../../types";
import { readWaystarCredentials } from "./credentials";
import { readWaystarEligibilityWorkbook } from "./input";
import { getWaystarPayer } from "./payer-registry";
import { loginToWaystar, submitWaystarInquiry } from "./portal";

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
      const routing = await readWaystarEligibilityWorkbook(input.inputFile);
      const credentials = await readWaystarCredentials(input.credentialFile);
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

      let completed = 0;
      let browser: Browser | null = null;
      let browserContext: BrowserContext | null = null;
      let page: Page | null = null;

      try {
        const session = await launchAutomationBrowser();
        browser = session.browser;
        browserContext = session.context;
        page = await browserContext.newPage();
        await loginToWaystar(page, credentials);
        await context.log({
          level: "info",
          message: "Waystar login completed successfully without OTP.",
          eventName: "eligibility_waystar_login_complete",
        });

        for (const batch of routing.batches) {
          const payer = getWaystarPayer(batch.payerId);
          if (payer.id !== "medicare") {
            completed += batch.rows.length;
            await context.log({
              level: "warn",
              message: `Skipping ${batch.rows.length} ${payer.name} row(s). Only Waystar Medicare is implemented right now.`,
              eventName: "eligibility_payer_not_implemented",
              meta: { payerId: payer.id, rowCount: batch.rows.length },
            });
            await context.emit({ type: "progress", completed, total: routing.totalRows });
            continue;
          }

          for (const row of batch.rows) {
            if (context.isCancelled?.()) {
              await context.log({
                level: "warn",
                message: "Eligibility run cancellation requested. Stopping after the current row.",
                eventName: "eligibility_cancel_requested",
              });
              return;
            }

            try {
              ensureRequiredFields(row, payer.requiredFields);
              const payload = await submitWaystarInquiry({
                page,
                credentials,
                payerName: payer.portalPayerName,
                row,
              });
              const result = payer.parseResult(payload, row);
              await context.log({
                level: "info",
                message: `Medicare eligibility row ${row.originalIndex} completed with ${result.coverageStatus} coverage.`,
                rowIndex: row.originalIndex,
                eventName: "eligibility_row_completed",
                meta: result.metadata as Record<string, unknown> | undefined,
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown Waystar Medicare automation error.";
              await context.log({
                level: "error",
                message: `Medicare eligibility row ${row.originalIndex} failed: ${message}`,
                rowIndex: row.originalIndex,
                eventName: "eligibility_row_failed",
              });
              const artifactPath = await saveRowScreenshot(context.jobId, page, row.originalIndex);
              if (artifactPath) {
                await context.emit({
                  type: "error_screenshot",
                  index: row.originalIndex,
                  filename: `waystar-medicare-row-${row.originalIndex}.jpg`,
                  path: artifactPath,
                  mimeType: "image/jpeg",
                });
              }
            }

            completed += 1;
            await context.emit({ type: "progress", completed, total: routing.totalRows });
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

async function saveRowScreenshot(jobId: string, page: Page, rowIndex: number): Promise<string> {
  try {
    return await saveScreenshotForJob({
      jobId,
      page,
      filename: `waystar-medicare-row-${rowIndex}.jpg`,
    });
  } catch {
    return "";
  }
}
