import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { AutomationRunner } from "../../../types";
import type { EligibilityResult, EligibilityRunInput } from "../../types";
import { parseEligibilityProjectId } from "../../projects";
import { medicalOutputValues, buildMediCalOutput, readMediCalCredentials, readMediCalInput } from "./data";
import { loginMediCal, verifyMediCalRow } from "./portal";
import { mediCalDnsArgs } from "./dns";
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { watchMediCalCancellation } from './cancellation';

export function createMediCalEligibilityRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification", portalId: "medical", name: "MedRevenu MediCal Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("MediCal input must be multipart form data.");
      const projectId = parseEligibilityProjectId(input.get("projectId"));
      if (projectId !== "medrevenue") throw new Error("MediCal eligibility is available only for MedRevenu.");
      const inputFile = input.get("inputFile");
      const credentialFile = input.get("credentialFile");
      if (!(inputFile instanceof File) || !inputFile.size || !(credentialFile instanceof File) || !credentialFile.size) throw new Error("Eligibility and credential workbooks are required.");
      return { projectId, inputFile, credentialFile };
    },
    async run(input, context) {
      if (input.projectId !== "medrevenue") throw new Error("MediCal eligibility is available only for MedRevenu.");
      const inputRows = await readMediCalInput(input.inputFile);
      if (!inputRows.length) throw new Error('No matching MedRevenu Medi-Cal eligibility rows found. Primary Insurance Name must be Medi-Cal, Medicare, Molina, Molina Healthcare, or medicare/molina. If provided, Project must be MedRevenu or MedRevenue.');
      const credentials = await readMediCalCredentials(input.credentialFile);
      const rows = new Map(inputRows.map((row) => [row.originalIndex, row]));
      const results = new Map<number, EligibilityResult>();
      const errors = new Map<number, string>();
      const outputDirectory = await mkdtemp(path.join(tmpdir(), 'medical-output-'));
      const saveOutput = async (type: 'output_snapshot' | 'file_download') => {
        const output = await buildMediCalOutput({ inputFile: input.inputFile, rows, results, errors });
        const outputPath = path.join(outputDirectory, `${type}-${results.size}-${errors.size}.xlsx`);
        await writeFile(outputPath, output);
        await context.emit({ type, path: outputPath, filename: 'medrevenue-medical-eligibility-output.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', base64: output.toString('base64') });
      };
      await saveOutput('output_snapshot');
      await context.emit({ type: "progress", completed: 0, total: rows.size });
      const extraArgs = await mediCalDnsArgs(credentials.loginUrl, async message => {
        await context.log({ level: "info", message, eventName: "eligibility_medical_dns" });
      });
      if (context.isCancelled?.()) { await saveOutput('file_download'); return; }
      const { browser, context: browserContext } = await launchAutomationBrowser({ extraArgs });
      let page: Awaited<ReturnType<typeof browserContext.newPage>> | undefined;
      const stopCancellationWatch = watchMediCalCancellation(browserContext, context.isCancelled);
      try {
        if (context.isCancelled?.()) return;
        page = await browserContext.newPage();
        page.setDefaultTimeout(30_000);
        const loginEvents: Array<{ host: string; status?: number; code?: string }> = [];
        const onResponse = (response: import('playwright-core').Response) => {
          if (response.status() >= 400 && loginEvents.length < 100) loginEvents.push({ host: new URL(response.url()).hostname, status: response.status() });
        };
        const onFailed = (request: import('playwright-core').Request) => {
          if (loginEvents.length < 100) loginEvents.push({ host: new URL(request.url()).hostname, code: request.failure()?.errorText.match(/ERR_[A-Z_]+/)?.[0] || 'NETWORK_FAILURE' });
        };
        page.on('response', onResponse);
        page.on('requestfailed', onFailed);
        let inquiryUrl: string;
        try {
          inquiryUrl = await loginMediCal(page, credentials, {
            isCancelled: context.isCancelled,
            report: async message => { await context.log({ level: 'info', message, eventName: 'eligibility_medical_login' }); },
          });
        } catch (error) {
          if (context.isCancelled?.()) throw error;
          await context.emit({ type: 'file_download', filename: 'medical-login-diagnostics.json', mimeType: 'application/json', base64: Buffer.from(JSON.stringify({ events: loginEvents }, null, 2)).toString('base64') });
          const screenshot = await page.screenshot({ type: 'jpeg', quality: 80, mask: [page.locator('input, textarea')] }).catch(() => null);
          if (screenshot) await context.emit({ type: 'error_screenshot', index: 0, filename: 'medical-login.jpg', image: screenshot.toString('base64'), mimeType: 'image/jpeg' });
          throw error;
        } finally {
          page.off('response', onResponse);
          page.off('requestfailed', onFailed);
        }
        let completed = 0;
        for (const row of inputRows) {
          if (context.isCancelled?.()) break;
          const rowIndex = row.originalIndex;
          await context.log({ level: "info", message: `Row ${rowIndex}: starting MediCal eligibility.`, rowIndex, eventName: "eligibility_medical_row_started" });
          try {
            results.set(rowIndex, await verifyMediCalRow(page, inquiryUrl, row, async message => {
              await context.log({ level: "info", message: `Row ${rowIndex}: ${message}`, rowIndex, eventName: "eligibility_medical_step" });
            }));
            await context.log({ level: "info", message: `Row ${rowIndex}: MediCal response extracted.`, rowIndex, eventName: "eligibility_medical_row_complete" });
          } catch (error) {
            if (context.isCancelled?.()) break;
            const message = error instanceof Error ? error.message : "MediCal row processing failed.";
            errors.set(rowIndex, message);
            await context.log({ level: "error", message, rowIndex, eventName: "eligibility_medical_row_failed" });
            const screenshot = await page.screenshot({ type: "jpeg", quality: 80 }).catch(() => null);
            if (screenshot) await context.emit({ type: "error_screenshot", index: rowIndex, filename: `medical-row-${rowIndex}.jpg`, image: screenshot.toString("base64"), mimeType: "image/jpeg" });
          }
          const result = results.get(rowIndex);
          await context.emit({ type: "eligibility_medical_result", rowIndex, update: { __rowKey: String(rowIndex), ...medicalOutputValues(result, errors.get(rowIndex)) } });
          await context.emit({ type: "progress", completed: ++completed, total: rows.size, currentRow: rowIndex });
          await saveOutput('output_snapshot');
        }
        if (errors.size && !context.isCancelled?.()) {
          throw new Error(`Medi-Cal verification failed for ${errors.size} of ${rows.size} rows. Review the row errors and downloaded workbook for the portal message.`);
        }
      } finally {
        stopCancellationWatch();
        try { await saveOutput('file_download'); }
        finally { await closeAutomationResources({ browser, context: browserContext, page, log: (message) => context.log({ level: "debug", message, eventName: "eligibility_medical_cleanup" }) }); }
      }
    },
  };
}
