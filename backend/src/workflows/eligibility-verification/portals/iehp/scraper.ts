import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { AutomationRunner } from "../../../types";
import type { EligibilityResult, EligibilityRunInput } from "../../types";
import { parseEligibilityProjectId } from "../../projects";
import { iehpOutputValues, buildIehpOutput, readIehpCredentials, readIehpInput } from "./data";
import { loginIehp, verifyIehpRow } from "./portal";

export function createIehpEligibilityRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification", portalId: "iehp", name: "MedRevenu Iehp Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("Iehp input must be multipart form data.");
      const projectId = parseEligibilityProjectId(input.get("projectId"));
      if (projectId !== "medrevenue") throw new Error("Iehp eligibility is available only for MedRevenu.");
      const inputFile = input.get("inputFile");
      const credentialFile = input.get("credentialFile");
      if (!(inputFile instanceof File) || !inputFile.size || !(credentialFile instanceof File) || !credentialFile.size) throw new Error("Eligibility and credential workbooks are required.");
      return { projectId, inputFile, credentialFile };
    },
    async run(input, context) {
      if (input.projectId !== "medrevenue") throw new Error("Iehp eligibility is available only for MedRevenu.");
      const inputRows = await readIehpInput(input.inputFile);
      if (!inputRows.length) throw new Error("No MedRevenu eligibility rows found.");
      const credentials = await readIehpCredentials(input.credentialFile);
      const rows = new Map(inputRows.map((row) => [row.originalIndex, row]));
      const results = new Map<number, EligibilityResult>();
      const errors = new Map<number, string>();
      await context.emit({ type: "progress", completed: 0, total: rows.size });
      const { browser, context: browserContext } = await launchAutomationBrowser();
      let page: Awaited<ReturnType<typeof browserContext.newPage>> | undefined;
      try {
        page = await browserContext.newPage();
        page.setDefaultTimeout(30_000);
        const inquiryUrl = await loginIehp(page, credentials);
        let completed = 0;
        for (const row of inputRows) {
          if (context.isCancelled?.()) break;
          const rowIndex = row.originalIndex;
          await context.log({ level: "info", message: `Row ${rowIndex}: starting Iehp eligibility.`, rowIndex, eventName: "eligibility_iehp_row_started" });
          try {
            results.set(rowIndex, await verifyIehpRow(page, inquiryUrl, row, async message => {
              await context.log({ level: "info", message: `Row ${rowIndex}: ${message}`, rowIndex, eventName: "eligibility_iehp_step" });
            }));
            await context.log({ level: "info", message: `Row ${rowIndex}: Iehp response extracted.`, rowIndex, eventName: "eligibility_iehp_row_complete" });
          } catch (error) {
            const message = error instanceof Error ? error.message : "Iehp row processing failed.";
            errors.set(rowIndex, message);
            await context.log({ level: "error", message, rowIndex, eventName: "eligibility_iehp_row_failed" });
            const screenshot = await page.screenshot({ type: "jpeg", quality: 80 }).catch(() => null);
            if (screenshot) await context.emit({ type: "error_screenshot", index: rowIndex, filename: `iehp-row-${rowIndex}.jpg`, image: screenshot.toString("base64"), mimeType: "image/jpeg" });
          }
          const result = results.get(rowIndex);
          await context.emit({ type: "eligibility_iehp_result", rowIndex, update: { __rowKey: String(rowIndex), ...iehpOutputValues(result, errors.get(rowIndex)) } });
          await context.emit({ type: "progress", completed: ++completed, total: rows.size, currentRow: rowIndex });
        }
        const output = await buildIehpOutput({ inputFile: input.inputFile, rows, results, errors });
        await context.emit({ type: "file_download", filename: "medrevenue-iehp-eligibility-output.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: output.toString("base64") });
      } finally {
        await closeAutomationResources({ browser, context: browserContext, page, log: (message) => context.log({ level: "debug", message, eventName: "eligibility_iehp_cleanup" }) });
      }
    },
  };
}
