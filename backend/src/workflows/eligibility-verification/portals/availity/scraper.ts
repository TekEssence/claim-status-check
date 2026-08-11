import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import type { AutomationContext, AutomationRunner, JobEvent, LogEvent } from "../../../types";
import type { EligibilityRunInput } from "../../types";
import { authenticateAvailityEligibility } from "./authentication";
import { launchAvailityEligibilityBrowser } from "./browser";
import {
  findAvailityEligibilityCredentialsForPayer,
  readAvailityEligibilityCredentialProfiles,
} from "./credentials";
import {
  AVAILITY_ORIGINAL_ROW_FIELD,
  readAvailityEligibilityInputPayers,
} from "./input-routing";
import { getAvailityEligibilityPayer } from "./payers/registry";

function requireFile(formData: FormData, key: string, label: string): File {
  const value = formData.get(key);
  if (!(value instanceof File) || value.size === 0) throw new Error(`${label} is required.`);
  return value;
}

function isExcelDownload(event: JobEvent): event is JobEvent & { base64: string } {
  return event.type === "file_download"
    && event.mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    && typeof event.base64 === "string";
}

function readOutputRows(base64: string): Record<string, unknown>[] {
  const workbook = XLSX.read(Buffer.from(base64, "base64"), { type: "buffer" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return sheet
    ? XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false })
    : [];
}

class AvailityCancellation extends Error {
  constructor() {
    super("Availity eligibility cancellation requested.");
    this.name = "AvailityCancellation";
  }
}

async function readOriginalRows(inputFile: File): Promise<Record<string, unknown>[]> {
  const workbook = XLSX.read(await inputFile.arrayBuffer(), { type: "array" });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) return [];
  return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: false })
    .map((row, index) => ({ ...row, [AVAILITY_ORIGINAL_ROW_FIELD]: index + 2 }));
}

function buildMergedOutput(options: {
  originalRows: Record<string, unknown>[];
  completedRows: Record<string, unknown>[];
  rowUpdates: Map<number, Record<string, unknown>>;
  unprocessedError?: string;
}): Buffer {
  const completedByRow = new Map<number, Record<string, unknown>>();
  for (const row of options.completedRows) {
    completedByRow.set(Number(row[AVAILITY_ORIGINAL_ROW_FIELD]), row);
  }

  const ordered = options.originalRows.map((original) => {
    const rowNumber = Number(original[AVAILITY_ORIGINAL_ROW_FIELD]);
    const completed = completedByRow.get(rowNumber);
    const update = options.rowUpdates.get(rowNumber);
    const row = { ...(completed ?? original), ...(update ?? {}) };
    if (options.unprocessedError && !completed && !update) {
      row.Error = options.unprocessedError;
    }
    delete row[AVAILITY_ORIGINAL_ROW_FIELD];
    return row;
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(ordered), "Eligibility Output");
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

function translateRowIndex(localRowIndex: number, originalRows: number[]): number {
  return localRowIndex >= 2
    ? originalRows[localRowIndex - 2] ?? localRowIndex
    : localRowIndex;
}

export function createAvailityEligibilityRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification",
    portalId: "availity",
    name: "Availity Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("Availity eligibility input must be multipart form data.");
      return {
        inputFile: requireFile(input, "inputFile", "Eligibility input file"),
        credentialFile: requireFile(input, "credentialFile", "Availity login file"),
      };
    },
    async run(input, context) {
      const batches = await readAvailityEligibilityInputPayers(input.inputFile);
      const credentialProfiles = await readAvailityEligibilityCredentialProfiles(input.credentialFile);
      const log = async (message: string) => context.log({
        level: "info",
        message,
        eventName: "eligibility_availity_authentication",
      });

      let session: Awaited<ReturnType<typeof launchAvailityEligibilityBrowser>> | null = null;
      let activeLoginIdentity: string | null = null;
      let activePayerName = "Not started";
      let stage = "input routing";
      const totalRows = batches.reduce((sum, batch) => sum + batch.rowCount, 0);
      const originalRows = await readOriginalRows(input.inputFile);
      const mergedOutputRows: Record<string, unknown>[] = [];
      const rowUpdates = new Map<number, Record<string, unknown>>();
      let completedRows = 0;
      let finalOutputEmitted = false;
      const safeJobId = context.jobId.replace(/[^a-zA-Z0-9_-]+/g, "_");
      const backupDirectory = path.join(process.cwd(), "data", "outputs", "availity", safeJobId);
      fs.mkdirSync(backupDirectory, { recursive: true });
      const backupOutputPath = path.join(backupDirectory, "availity-eligibility-output-latest.xlsx");
      let lastBackupError = "";

      const persistBackupOutput = (unprocessedError = "Pending - not processed"): Buffer => {
        const output = buildMergedOutput({
          originalRows,
          completedRows: mergedOutputRows,
          rowUpdates,
          unprocessedError,
        });
        const temporaryPath = `${backupOutputPath}.tmp`;
        try {
          fs.writeFileSync(temporaryPath, output);
          if (fs.existsSync(backupOutputPath)) fs.rmSync(backupOutputPath, { force: true });
          fs.renameSync(temporaryPath, backupOutputPath);
          lastBackupError = "";
        } catch (error) {
          lastBackupError = error instanceof Error ? error.message : String(error);
          try {
            fs.writeFileSync(backupOutputPath, output);
            lastBackupError = "";
          } catch (fallbackError) {
            lastBackupError = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
          }
        } finally {
          if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
        }
        return output;
      };

      const emitFinalOutput = async (unprocessedError?: string) => {
        if (finalOutputEmitted) return;
        const output = persistBackupOutput(unprocessedError || "");
        await context.emit({
          type: "file_download",
          filename: "availity-eligibility-output.xlsx",
          mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          base64: output.toString("base64"),
        });
        finalOutputEmitted = true;
      };

      try {
        persistBackupOutput();
        await context.log({
          level: "info",
          message: `Detected ${batches.length} payer batch(es) across ${totalRows} row(s).`,
          eventName: "eligibility_availity_batches_detected",
        });

        for (const batch of batches) {
          if (context.isCancelled?.()) throw new AvailityCancellation();
          const payer = getAvailityEligibilityPayer(batch.payerId);
          activePayerName = batch.payerId;
          const credentials = findAvailityEligibilityCredentialsForPayer(
            credentialProfiles,
            batch.payerId,
            payer.name,
          );
          if (!credentials) {
            throw new Error(
              `No Availity credential row matches ${batch.payerId}. Add a Payer column to the login workbook, or provide one shared Availity credential row.`,
            );
          }

          const loginIdentity = `${credentials.loginUrl}\u0000${credentials.username}`;
          if (!session || activeLoginIdentity !== loginIdentity) {
            if (session) {
              await log(`Switching Availity login before processing ${batch.payerId}.`);
              await session.browser.close().catch(() => {});
            }
            stage = `Availity login for ${batch.payerId}`;
            session = await launchAvailityEligibilityBrowser(log);
            const loginPage = session.context.pages()[0] ?? await session.context.newPage();
            loginPage.setDefaultTimeout(Number(process.env.PORTAL_AVAILITY_ELIGIBILITY_DEFAULT_TIMEOUT_MS || 30_000));
            loginPage.setDefaultNavigationTimeout(Number(process.env.PORTAL_AVAILITY_ELIGIBILITY_NAVIGATION_TIMEOUT_MS || 45_000));
            await authenticateAvailityEligibility(loginPage, credentials);
            activeLoginIdentity = loginIdentity;
            await context.log({
              level: "info",
              message: `Availity login completed for ${batch.payerId}.`,
              eventName: "eligibility_availity_login_complete",
              meta: { payerId: batch.payerId, username: credentials.username },
            });
          } else {
            await context.log({
              level: "info",
              message: `Reusing the active Availity login for ${batch.payerId}.`,
              eventName: "eligibility_availity_session_reused",
              meta: { payerId: batch.payerId, username: credentials.username },
            });
          }

          const page = session.context.pages().find((candidate) => !candidate.isClosed())
            ?? await session.context.newPage();
          stage = `Patient Registration > Eligibility and Benefits Inquiry > ${batch.payerId} processing`;
          const batchOffset = completedRows;
          let currentBatchProgress = 0;
          const translateLog = (event: LogEvent): LogEvent => {
            const translated = {
              ...event,
              ...(typeof event.rowIndex === "number"
                ? { rowIndex: translateRowIndex(event.rowIndex, batch.originalRowNumbers) }
                : {}),
            };
            if (
              translated.level === "error"
              && typeof translated.rowIndex === "number"
            ) {
              rowUpdates.set(translated.rowIndex, { Error: translated.message });
              persistBackupOutput();
            }
            return translated;
          };
          const batchContext: AutomationContext = {
            ...context,
            log: (event) => context.log(translateLog(event)),
            emit: async (event) => {
              if (isExcelDownload(event)) {
                mergedOutputRows.push(...readOutputRows(event.base64));
                persistBackupOutput();
                return;
              }
              if (
                event.type === "progress"
                && typeof event.completed === "number"
              ) {
                currentBatchProgress = Math.max(currentBatchProgress, event.completed);
                await context.emit({
                  ...event,
                  completed: Math.min(batchOffset + event.completed, totalRows),
                  total: totalRows,
                });
                if (context.isCancelled?.()) throw new AvailityCancellation();
                return;
              }
              if (typeof event.rowIndex === "number") {
                const translatedRowIndex = translateRowIndex(
                  event.rowIndex,
                  batch.originalRowNumbers,
                );
                if (
                  event.type === "eligibility_availity_result"
                  && event.update
                  && typeof event.update === "object"
                ) {
                  rowUpdates.set(
                    translatedRowIndex,
                    event.update as Record<string, unknown>,
                  );
                  persistBackupOutput();
                }
                await context.emit({
                  ...event,
                  rowIndex: translatedRowIndex,
                });
                return;
              }
              await context.emit(event);
            },
          };
          let heartbeatRunning = false;
          const heartbeat = setInterval(() => {
            if (heartbeatRunning) return;
            heartbeatRunning = true;
            const currentCompleted = Math.min(batchOffset + currentBatchProgress, totalRows);
            void Promise.allSettled([
              context.log({
                level: "info",
                message: `Still processing ${batch.payerId}: ${currentBatchProgress} of ${batch.rowCount} row(s) completed in this payer batch.`,
                eventName: "eligibility_availity_processing_heartbeat",
                meta: { payerId: batch.payerId, completed: currentCompleted, total: totalRows },
              }),
              context.emit({ type: "progress", completed: currentCompleted, total: totalRows }),
            ]).finally(() => {
              heartbeatRunning = false;
            });
          }, 15_000);
          try {
            await payer.run({ page, inputFile: batch.inputFile, context: batchContext });
          } finally {
            clearInterval(heartbeat);
          }
          completedRows += batch.rowCount;
          persistBackupOutput();
          await context.emit({ type: "progress", completed: completedRows, total: totalRows });
        }

        if (!mergedOutputRows.length && !rowUpdates.size) {
          throw new Error("No Availity eligibility output rows were produced.");
        }
        await emitFinalOutput();
        await context.log({
          level: "info",
          message: `Created one combined Availity eligibility output workbook in original input order. Backup: ${backupOutputPath}${lastBackupError ? ` (backup warning: ${lastBackupError})` : ""}.`,
          eventName: "eligibility_availity_output_created",
        });
        stage = "completed";
      } catch (error) {
        if (error instanceof AvailityCancellation || context.isCancelled?.()) {
          await emitFinalOutput("Cancelled - not processed");
          await context.log({
            level: "warn",
            message: `Availity eligibility was cancelled. Created a partial workbook with ${rowUpdates.size} processed row(s).`,
            eventName: "eligibility_availity_cancelled_output_created",
          }).catch(() => {});
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        await emitFinalOutput(`Not processed because the run failed: ${message}`).catch(() => {});
        const stack = error instanceof Error ? error.stack || "Stack trace unavailable." : "Stack trace unavailable.";
        const page = session?.context.pages().find((candidate) => !candidate.isClosed());
        const title = page ? await page.title().catch(() => "Unavailable") : "Unavailable";
        const report = [
          "Availity eligibility error report",
          `Generated: ${new Date().toISOString()}`,
          `Job ID: ${context.jobId}`,
          "Workflow: Eligibility Verification",
          "Portal: Availity",
          `Payer: ${activePayerName}`,
          `Failed stage: ${stage}`,
          `Page URL: ${page?.url() || "Unavailable"}`,
          `Page title: ${title || "Unavailable"}`,
          "",
          `Error: ${message}`,
          "",
          "Stack trace:",
          stack,
        ].join("\n");
        await context.emit({
          type: "file_download",
          filename: "availity-eligibility-error-report.txt",
          mimeType: "text/plain",
          base64: Buffer.from(report, "utf8").toString("base64"),
        }).catch(() => {});
        const screenshot = page
          ? await page.screenshot({ type: "jpeg", quality: 80, fullPage: true }).catch(() => null)
          : null;
        if (screenshot) {
          await context.emit({
            type: "error_screenshot",
            index: -1,
            filename: "availity-eligibility-error-screenshot.jpg",
            image: screenshot.toString("base64"),
          }).catch(() => {});
        }
        await context.log({
          level: "error",
          message: `Availity eligibility failed during ${stage}: ${message}`,
          eventName: "eligibility_availity_failed",
          meta: { stage, url: page?.url() || "" },
        }).catch(() => {});
        throw error;
      } finally {
        await session?.browser.close().catch(() => {});
      }
    },
  };
}