import { launchAutomationBrowser } from "@/backend/src/core/browser";
import { closeAutomationResources } from "@/backend/src/core/runtime-config";
import type { AutomationRunner } from "../../../types";
import type { EligibilityResult, EligibilityRunInput } from "../../types";
import { parseEligibilityProjectId } from "../../projects";
import { buildTriZettoOutput, readTriZettoCredentials, readTriZettoInput } from "./data";
import { loginTriZetto, verifyTriZettoRow } from "./portal";

export function createTriZettoEligibilityRunner(): AutomationRunner<EligibilityRunInput> {
  return {
    workflowId: "eligibility-verification", portalId: "trizetto", name: "MedRevenu TriZetto Eligibility Verification",
    validateInput(input) {
      if (!(input instanceof FormData)) throw new Error("TriZetto input must be multipart form data.");
      const projectId = parseEligibilityProjectId(input.get("projectId"));
      if (projectId !== "medrevenue") throw new Error("TriZetto eligibility is available only for MedRevenu.");
      const inputFile = input.get("inputFile");
      const credentialFile = input.get("credentialFile");
      if (!(inputFile instanceof File) || !inputFile.size || !(credentialFile instanceof File) || !credentialFile.size) throw new Error("Eligibility and credential workbooks are required.");
      return { projectId, inputFile, credentialFile };
    },
    async run(input, context) {
      if (input.projectId !== "medrevenue") throw new Error("TriZetto eligibility is available only for MedRevenu.");
      const inputRows = await readTriZettoInput(input.inputFile);
      if (!inputRows.length) throw new Error("No MedRevenu eligibility rows found.");
      const credentials = await readTriZettoCredentials(input.credentialFile);
      const rows = new Map(inputRows.map((row) => [row.originalIndex, row]));
      const results = new Map<number, EligibilityResult>();
      const errors = new Map<number, string>();
      await context.emit({ type: "progress", completed: 0, total: rows.size });
      const { browser, context: browserContext } = await launchAutomationBrowser();
      let page: Awaited<ReturnType<typeof browserContext.newPage>> | undefined;
      try {
        page = await browserContext.newPage();
        page.setDefaultTimeout(30_000);
        const inquiryUrl = await loginTriZetto(page, credentials, context);
        let completed = 0;
        for (const row of inputRows) {
          if (context.isCancelled?.()) break;
          const rowIndex = row.originalIndex;
          await context.log({ level: "info", message: `Row ${rowIndex}: starting TriZetto eligibility.`, rowIndex, eventName: "eligibility_trizetto_row_started" });
          try {
            results.set(rowIndex, await verifyTriZettoRow(page, inquiryUrl, row));
            await context.log({ level: "info", message: `Row ${rowIndex}: TriZetto response extracted.`, rowIndex, eventName: "eligibility_trizetto_row_complete" });
          } catch (error) {
            const message = error instanceof Error ? error.message : "TriZetto row processing failed.";
            errors.set(rowIndex, message);
            await context.log({ level: "error", message, rowIndex, eventName: "eligibility_trizetto_row_failed" });
            const screenshot = await page.screenshot({ type: "jpeg", quality: 80 }).catch(() => null);
            if (screenshot) await context.emit({ type: "error_screenshot", index: rowIndex, filename: `trizetto-row-${rowIndex}.jpg`, image: screenshot.toString("base64"), mimeType: "image/jpeg" });
          }
          const result = results.get(rowIndex);
          await context.emit({ type: "eligibility_trizetto_result", rowIndex, update: { __rowKey: String(rowIndex),
            "Patient Name": result?.patientName ?? "",
            "Coverage Status": errors.has(rowIndex) ? "error" : result?.coverageStatus ?? "unknown", "Eff Date": result?.effectiveDate ?? "", "End Date": "",
            "Other Ins": "", "Other Ins Eff Date": "", "Relationship to Subscriber": result?.relationshipToSubscriber ?? "", "Plan Type": "", "Bot Insurance Type": "",
            "Plan Date": result?.planDate ?? "", "Service Type": String(result?.metadata?.medRevenueOutputServiceType ?? ""),
            Description: errors.get(rowIndex) || String(result?.metadata?.trizettoDescription ?? "") } });
          await context.emit({ type: "progress", completed: ++completed, total: rows.size, currentRow: rowIndex });
        }
        const output = await buildTriZettoOutput({ inputFile: input.inputFile, rows, results, errors });
        await context.emit({ type: "file_download", filename: "medrevenue-trizetto-eligibility-output.xlsx", mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: output.toString("base64") });
      } finally {
        await closeAutomationResources({ browser, context: browserContext, page, log: (message) => context.log({ level: "debug", message, eventName: "eligibility_trizetto_cleanup" }) });
      }
    },
  };
}
