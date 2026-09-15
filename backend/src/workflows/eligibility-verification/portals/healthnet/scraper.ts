import { launchHealthNetBrowser } from './browser';
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { AutomationRunner } from "../../../types";
import type { EligibilityResult, EligibilityRunInput } from "../../types";
import { parseEligibilityProjectId } from "../../projects";
import { healthnetOutputValues, buildHealthNetOutput, readHealthNetCredentials, readHealthNetInput } from "./data";
import { loginHealthNet, verifyHealthNetRow } from "./portal";
import { startHealthNetLoginDiagnostics } from './login-diagnostics';

export function createHealthNetEligibilityRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification", portalId: "healthnet", name: "MedRevenu HealthNet Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("HealthNet input must be multipart form data.");
      const projectId = parseEligibilityProjectId(input.get("projectId"));
      if (projectId !== "medrevenue") throw new Error("HealthNet eligibility is available only for MedRevenu.");
      const inputFile = input.get("inputFile");
      const credentialFile = input.get("credentialFile");
      if (!(inputFile instanceof File) || !inputFile.size || !(credentialFile instanceof File) || !credentialFile.size) throw new Error("Eligibility and credential workbooks are required.");
      return { projectId, inputFile, credentialFile };
    },
    async run(input, context) {
      if (input.projectId !== "medrevenue") throw new Error("HealthNet eligibility is available only for MedRevenu.");
      const inputRows = await readHealthNetInput(input.inputFile);
      if (!inputRows.length) throw new Error("No MedRevenu eligibility rows found.");
      const credentials = await readHealthNetCredentials(input.credentialFile);
      const rows = new Map(inputRows.map((row) => [row.originalIndex, row]));
      const results = new Map<number, EligibilityResult>();
      const errors = new Map<number, string>();
      await context.emit({ type: "progress", completed: 0, total: rows.size });
      const launched = await launchHealthNetBrowser();
      const browser = launched.browser;
      let browserContext = launched.context;
      let page: Awaited<ReturnType<typeof browserContext.newPage>> | undefined;
      try {
        page = await browserContext.newPage();
        page.setDefaultTimeout(30_000);
        const diagnostics = startHealthNetLoginDiagnostics(page);
        let inquiryUrl: string;
        try {
          inquiryUrl = await loginHealthNet(page, credentials, context);
        } catch (error) {
          await diagnostics.finish(context, 'failure', error);
          const failedBeforeMfa = error instanceof Error && /authentication was denied three times|did not reach Text Message verification screen|Text Message verification screen did not load/.test(error.message);
          if (browser && failedBeforeMfa && !context.isCancelled?.() && !page.isClosed()) {
            await context.log({ level: 'warn', eventName: 'eligibility_healthnet_automatic_retry', message: 'Health Net did not reach verification. Retrying login once in a fresh browser session using the supplied credentials. No manual sign-in is required.' });
            await browserContext.close();
            browserContext = await browser.newContext({ acceptDownloads: true, viewport: { width: 1920, height: 1080 }, locale: 'en-US' });
            page = await browserContext.newPage();
            page.setDefaultTimeout(30_000);
            if (context.isCancelled?.()) throw new Error('Health Net login cancelled.');
            const recoveryDiagnostics = startHealthNetLoginDiagnostics(page);
            try {
              inquiryUrl = await loginHealthNet(page, credentials, context);
              await recoveryDiagnostics.finish(context, 'success');
            } catch (recoveryError) {
              await recoveryDiagnostics.finish(context, 'failure', recoveryError);
              throw new Error('Health Net automatic login failed after one fresh-session retry. The verification screen was not reached. No eligibility searches were performed. Review the login diagnostics for the SSO failure.');
            }
          } else {
          // Playwright's raw error includes redirect URLs, query tokens and
          // occasionally entered values. Return only a safe summary to the UI.
          throw new Error('Health Net login did not complete. Download healthnet-login-diagnostics.json and review the masked login screenshot for the redirect failure.');
          }
        }
        await diagnostics.finish(context, 'success');
        let completed = 0;
        for (const row of inputRows) {
          if (context.isCancelled?.()) break;
          const rowIndex = row.originalIndex;
          await context.log({ level: "info", message: `Row ${rowIndex}: starting HealthNet eligibility.`, rowIndex, eventName: "eligibility_healthnet_row_started" });
          try {
            results.set(rowIndex, await verifyHealthNetRow(page, inquiryUrl, row, async message => {
              await context.log({ level: "info", message: `Row ${rowIndex}: ${message}`, rowIndex, eventName: "eligibility_healthnet_step" });
            }));
            await context.log({ level: "info", message: `Row ${rowIndex}: HealthNet response extracted.`, rowIndex, eventName: "eligibility_healthnet_row_complete" });
          } catch (error) {
            const message = error instanceof Error ? error.message : "HealthNet row processing failed.";
            errors.set(rowIndex, message);
            await context.log({ level: "error", message, rowIndex, eventName: "eligibility_healthnet_row_failed" });
            const screenshot = await page.screenshot({ type: "jpeg", quality: 80 }).catch(() => null);
            if (screenshot) await context.emit({ type: "error_screenshot", index: rowIndex, filename: `healthnet-row-${rowIndex}.jpg`, image: screenshot.toString("base64"), mimeType: "image/jpeg" });
          }
          const result = results.get(rowIndex);
          await context.emit({ type: "eligibility_healthnet_result", rowIndex, update: { __rowKey: String(rowIndex), ...healthnetOutputValues(result, errors.get(rowIndex)) } });
          await context.emit({ type: "progress", completed: ++completed, total: rows.size, currentRow: rowIndex });
        }
        const output = await buildHealthNetOutput({ inputFile: input.inputFile, rows, results, errors });
        await context.emit({ type: "file_download", filename: "medrevenue-healthnet-eligibility-output.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: output.toString("base64") });
      } finally {
        await closeAutomationResources({ browser, context: browserContext, page, log: (message) => context.log({ level: "debug", message, eventName: "eligibility_healthnet_cleanup" }) });
      }
    },
  };
}
